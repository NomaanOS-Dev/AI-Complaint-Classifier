import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
import httpx
from google.genai import errors as genai_errors
from openai import APIConnectionError, APIStatusError, APITimeoutError
from pydantic import ValidationError

from app.main import (
    ANALYSIS_SCHEMA,
    AnalysisRequest,
    AnalysisResponse,
    Category,
    ModelAnalysis,
    PriorityLabel,
    Sentiment,
    Severity,
    analyze_complaint,
    get_gemini_client,
    get_ollama_timeout,
    get_openai_client as create_openai_client,
    priority_label_for_score,
)


def output_payload(**overrides):
    payload = {
        "category": "payment",
        "sentiment": "negative",
        "severity": "high",
        "priority_score": 65,
        "priority_label": "high",
        "reasoning_summary": "Money was deducted, but the order is still pending.",
        "suggested_reply": "I’m sorry the payment was deducted while your order remains pending. Could you share the order reference so our team can check the status?",
    }
    return {**payload, **overrides}


class AnalysisOpenAITests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.client = SimpleNamespace(responses=SimpleNamespace(create=AsyncMock()))
        self.client.responses.create.return_value = SimpleNamespace(output_text=json.dumps(output_payload()))
        self.client_patch = patch("app.main.get_openai_client", return_value=self.client)
        self.client_patch.start()
        self.addCleanup(self.client_patch.stop)
        self.model_patch = patch.dict(os.environ, {
            "AI_PROVIDER": "openai",
            "OPENAI_MODEL": "gpt-6.1-sol",
            "OPENAI_API_KEY": "fake-openai-key",
            "GEMINI_API_KEY": "",
            "OLLAMA_BASE_URL": "",
        })
        self.model_patch.start()
        self.addCleanup(self.model_patch.stop)

    async def test_valid_structured_response_preserves_contract_and_calls_responses_api(self):
        result = await analyze_complaint(AnalysisRequest(title="Payment deducted", description="My card was charged but the order is pending."))

        self.assertIsInstance(result, AnalysisResponse)
        self.assertEqual(result.category, Category.payment)
        self.assertEqual(result.sentiment, Sentiment.negative)
        self.assertEqual(result.severity, Severity.high)
        self.assertEqual(result.priority_label, PriorityLabel.high)
        self.assertEqual(result.model_name, "gpt-6.1-sol")
        self.assertIn("order remains pending", result.suggested_reply)
        self.assertIn("Money was deducted", result.reasoning_summary)
        self.assertIsNotNone(result.analyzed_at.tzinfo)
        self.client.responses.create.assert_awaited_once()
        call = self.client.responses.create.await_args.kwargs
        self.assertEqual(call["model"], "gpt-6.1-sol")
        self.assertEqual(call["max_output_tokens"], 800)
        self.assertFalse(call["store"])
        self.assertEqual(call["text"]["format"]["type"], "json_schema")
        self.assertTrue(call["text"]["format"]["strict"])
        self.assertEqual(json.loads(call["input"][0]["content"])["title"], "Payment deducted")
        self.assertEqual(AnalysisResponse.model_validate(result.model_dump()), result)

    async def test_payment_failure_and_general_payment_question_use_model_results(self):
        cases = [
            (
                "Money deducted without order confirmation",
                "My card was charged, but I never received an order confirmation and the order is pending.",
                output_payload(category="payment", severity="high", priority_score=65, priority_label="high"),
            ),
            (
                "Question about payment methods",
                "Can I pay with a debit card or cash?",
                output_payload(category="payment", sentiment="neutral", severity="low", priority_score=15, priority_label="low", reasoning_summary="The customer asks which payment methods are accepted.", suggested_reply="You can check whether a debit card is available among the payment methods at checkout."),
            ),
        ]
        for title, description, expected in cases:
            with self.subTest(title=title):
                self.client.responses.create.return_value = SimpleNamespace(output_text=json.dumps(expected))
                result = await analyze_complaint(AnalysisRequest(title=title, description=description))
                self.assertEqual(result.category, Category.payment)
                self.assertEqual(result.severity.value, expected["severity"])
                if title == "Question about payment methods":
                    self.assertIn("payment methods", result.reasoning_summary)
                    self.assertIn("debit card", result.suggested_reply)
                self.assertIn(description, self.client.responses.create.await_args.kwargs["input"][0]["content"])

    async def test_invalid_fields_and_inconsistent_priority_are_rejected(self):
        invalid = [
            output_payload(category="unknown"),
            output_payload(priority_score=101),
            output_payload(priority_score=25, priority_label="low"),
            output_payload(suggested_reply=""),
            {**output_payload(), "extra": "not allowed"},
        ]
        for payload in invalid:
            with self.subTest(payload=payload):
                self.client.responses.create.return_value = SimpleNamespace(output_text=json.dumps(payload))
                with self.assertRaises(HTTPException) as caught:
                    await analyze_complaint(AnalysisRequest(title="Issue", description="Details"))
                self.assertEqual(caught.exception.status_code, 502)
                self.assertNotIn("Details", str(caught.exception.detail))

        with self.assertRaises(ValidationError):
            ModelAnalysis.model_validate(output_payload(priority_score=25, priority_label="low"))

    async def test_provider_failures_are_safe_and_do_not_retry(self):
        cases = [
            (APITimeoutError(request=None), 504),
            (APIConnectionError(message="offline", request=None), 503),
            (APIStatusError("rate limited", response=httpx.Response(429, request=httpx.Request("POST", "https://api.openai.com/v1/responses")), body=None), 503),
            (APIStatusError("unavailable", response=httpx.Response(503, request=httpx.Request("POST", "https://api.openai.com/v1/responses")), body=None), 503),
        ]
        for error, status in cases:
            with self.subTest(status=status, error=type(error).__name__):
                self.client.responses.create.reset_mock()
                self.client.responses.create.side_effect = error
                with self.assertRaises(HTTPException) as caught:
                    await analyze_complaint(AnalysisRequest(title="Private title", description="Private complaint content"))
                self.assertEqual(caught.exception.status_code, status)
                self.assertNotIn("Private complaint", str(caught.exception.detail))
                self.client.responses.create.assert_awaited_once()
        self.client.responses.create.side_effect = None

    async def test_missing_key_fails_clearly_without_constructing_a_client(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": ""}, clear=False):
            with self.assertRaises(HTTPException) as caught:
                create_openai_client()
            self.assertEqual(caught.exception.status_code, 503)
            self.assertIn("not configured", caught.exception.detail)

    def test_empty_and_oversized_input_are_rejected(self):
        for values in (
            {"title": " ", "description": "Valid"},
            {"title": "Valid", "description": " "},
            {"title": "x" * 201, "description": "Valid"},
            {"title": "Valid", "description": "x" * 10001},
        ):
            with self.subTest(title_length=len(values["title"]), description_length=len(values["description"])):
                with self.assertRaises(ValidationError):
                    AnalysisRequest(**values)

    def test_priority_thresholds_match_persisted_contract(self):
        expected = {
            0: PriorityLabel.low, 24: PriorityLabel.low,
            25: PriorityLabel.medium, 49: PriorityLabel.medium,
            50: PriorityLabel.high, 79: PriorityLabel.high,
            80: PriorityLabel.urgent, 100: PriorityLabel.urgent,
        }
        for score, label in expected.items():
            with self.subTest(score=score):
                self.assertEqual(priority_label_for_score(score), label)


class AnalysisGeminiTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.client = SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=AsyncMock())))
        self.client.aio.models.generate_content.return_value = SimpleNamespace(text=json.dumps(output_payload()))
        self.client_patch = patch("app.main.get_gemini_client", return_value=self.client)
        self.client_patch.start()
        self.addCleanup(self.client_patch.stop)
        self.provider_patch = patch.dict(os.environ, {
            "AI_PROVIDER": "gemini",
            "GEMINI_MODEL": "gemini-3.1-flash-lite",
            "GEMINI_API_KEY": "fake-gemini-key",
            "OPENAI_API_KEY": "",
            "OLLAMA_BASE_URL": "",
        })
        self.provider_patch.start()
        self.addCleanup(self.provider_patch.stop)

    async def test_selected_gemini_provider_requests_structured_json_and_preserves_contract(self):
        result = await analyze_complaint(AnalysisRequest(title="Payment deducted", description="My card was charged but the order is pending."))

        self.assertIsInstance(result, AnalysisResponse)
        self.assertEqual(result.category, Category.payment)
        self.assertEqual(result.priority_label, PriorityLabel.high)
        self.assertEqual(result.model_name, "gemini-3.1-flash-lite")
        self.assertIsNotNone(result.analyzed_at.tzinfo)
        self.client.aio.models.generate_content.assert_awaited_once()
        call = self.client.aio.models.generate_content.await_args.kwargs
        self.assertEqual(call["model"], "gemini-3.1-flash-lite")
        self.assertEqual(json.loads(call["contents"])["title"], "Payment deducted")
        self.assertEqual(call["config"].response_mime_type, "application/json")
        self.assertEqual(call["config"].response_json_schema, ANALYSIS_SCHEMA)
        self.assertEqual(call["config"].max_output_tokens, 800)
        self.assertIn("untrusted data", call["config"].system_instruction)
        self.assertEqual(AnalysisResponse.model_validate(result.model_dump()), result)

    async def test_malformed_gemini_response_is_rejected_by_shared_schema_validation(self):
        self.client.aio.models.generate_content.return_value = SimpleNamespace(
            text=json.dumps(output_payload(priority_score=25, priority_label="low"))
        )
        with self.assertRaises(HTTPException) as caught:
            await analyze_complaint(AnalysisRequest(title="Issue", description="Details"))
        self.assertEqual(caught.exception.status_code, 502)
        self.assertIn("invalid analysis response", caught.exception.detail)
        self.assertEqual(self.client.aio.models.generate_content.await_count, 1)

    async def test_gemini_retries_429_and_503_with_a_bounded_backoff(self):
        request = self.client.aio.models.generate_content
        request.side_effect = [
            genai_errors.APIError(429, {"message": "rate limited"}),
            genai_errors.APIError(503, {"message": "unavailable"}),
            SimpleNamespace(text=json.dumps(output_payload())),
        ]
        with patch("app.main.asyncio.sleep", new_callable=AsyncMock) as sleep:
            result = await analyze_complaint(AnalysisRequest(title="Issue", description="Details"))

        self.assertEqual(result.category, Category.payment)
        self.assertEqual(request.await_count, 3)
        self.assertEqual([call.args[0] for call in sleep.await_args_list], [0.25, 0.5])

    async def test_gemini_stops_after_three_transient_failures_without_provider_fallback(self):
        request = self.client.aio.models.generate_content
        request.side_effect = genai_errors.APIError(503, {"message": "unavailable"})
        with patch("app.main.asyncio.sleep", new_callable=AsyncMock):
            with self.assertRaises(HTTPException) as caught:
                await analyze_complaint(AnalysisRequest(title="Private title", description="Private complaint"))

        self.assertEqual(caught.exception.status_code, 503)
        self.assertEqual(request.await_count, 3)
        self.assertNotIn("Private complaint", caught.exception.detail)

    async def test_gemini_timeout_is_safe_and_not_retried(self):
        request = self.client.aio.models.generate_content
        request.side_effect = TimeoutError()
        with self.assertRaises(HTTPException) as caught:
            await analyze_complaint(AnalysisRequest(title="Issue", description="Details"))

        self.assertEqual(caught.exception.status_code, 504)
        self.assertEqual(request.await_count, 1)

    def test_gemini_missing_key_fails_without_constructing_a_client(self):
        with patch.dict(os.environ, {"GEMINI_API_KEY": ""}, clear=False):
            with patch("app.main.genai.Client") as client_factory:
                with self.assertRaises(HTTPException) as caught:
                    get_gemini_client()
        self.assertEqual(caught.exception.status_code, 503)
        self.assertIn("not configured", caught.exception.detail)
        client_factory.assert_not_called()

    def test_gemini_client_disables_sdk_retries_for_bounded_manual_retry_policy(self):
        with patch("app.main._gemini_client", None):
            with patch.dict(os.environ, {"GEMINI_API_KEY": "test-key"}, clear=False):
                with patch("app.main.genai.Client", return_value=self.client) as client_factory:
                    get_gemini_client()
        options = client_factory.call_args.kwargs["http_options"]
        self.assertEqual(options.timeout, 20_000)
        self.assertEqual(options.retry_options.attempts, 1)


class AnalysisFallbackAndOllamaTests(unittest.IsolatedAsyncioTestCase):
    async def test_openai_falls_back_to_gemini_on_rate_limit(self):
        openai_client = SimpleNamespace(responses=SimpleNamespace(create=AsyncMock()))
        openai_client.responses.create.side_effect = APIStatusError(
            "rate limited",
            response=httpx.Response(429, request=httpx.Request("POST", "https://api.openai.com/v1/responses")),
            body=None,
        )
        gemini_client = SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=AsyncMock())))
        gemini_client.aio.models.generate_content.return_value = SimpleNamespace(text=json.dumps(output_payload()))

        with patch.dict(os.environ, {
            "OPENAI_API_KEY": "fake-openai-key",
            "GEMINI_API_KEY": "fake-gemini-key",
            "OLLAMA_BASE_URL": "",
            "AI_PROVIDER": "fallback",
        }, clear=False):
            with patch("app.main.get_openai_client", return_value=openai_client), \
                 patch("app.main.get_gemini_client", return_value=gemini_client):
                result = await analyze_complaint(AnalysisRequest(title="Issue", description="Details"))
                self.assertEqual(result.category, Category.payment)
                self.assertEqual(result.model_name, "gemini-3.1-flash-lite")
                openai_client.responses.create.assert_awaited_once()
                gemini_client.aio.models.generate_content.assert_awaited_once()

    async def test_gemini_falls_back_to_ollama_on_failure(self):
        gemini_client = SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=AsyncMock())))
        gemini_client.aio.models.generate_content.side_effect = genai_errors.APIError(503, {"message": "service unavailable"})

        ollama_response = {
            "model": "llama3.2:latest",
            "message": {"role": "assistant", "content": json.dumps(output_payload())},
            "done": True,
        }

        with patch.dict(os.environ, {
            "OPENAI_API_KEY": "",  # unconfigured, skip
            "GEMINI_API_KEY": "fake-gemini-key",
            "OLLAMA_BASE_URL": "http://localhost:11434",
            "OLLAMA_MODEL": "llama3.2:latest",
            "AI_PROVIDER": "fallback",
        }, clear=False):
            with patch("app.main.get_gemini_client", return_value=gemini_client), \
                 patch("app.main.asyncio.sleep", new_callable=AsyncMock), \
                 patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
                mock_post.return_value = httpx.Response(200, json=ollama_response, request=httpx.Request("POST", "http://localhost:11434/api/chat"))
                result = await analyze_complaint(AnalysisRequest(title="Issue", description="Details"))
                self.assertEqual(result.category, Category.payment)
                self.assertEqual(result.model_name, "ollama-llama3.2-latest")
                mock_post.assert_awaited_once()

    async def test_full_chain_fallback_openai_to_gemini_to_ollama(self):
        openai_client = SimpleNamespace(responses=SimpleNamespace(create=AsyncMock()))
        openai_client.responses.create.side_effect = APITimeoutError(request=None)

        gemini_client = SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=AsyncMock())))
        gemini_client.aio.models.generate_content.side_effect = TimeoutError()

        ollama_response = {
            "model": "llama3.2",
            "message": {"role": "assistant", "content": json.dumps(output_payload())},
            "done": True,
        }

        with patch.dict(os.environ, {
            "OPENAI_API_KEY": "fake-openai-key",
            "GEMINI_API_KEY": "fake-gemini-key",
            "OLLAMA_BASE_URL": "http://localhost:11434",
            "OLLAMA_MODEL": "llama3.2",
            "AI_PROVIDER": "fallback",
        }, clear=False):
            with patch("app.main.get_openai_client", return_value=openai_client), \
                 patch("app.main.get_gemini_client", return_value=gemini_client), \
                 patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
                mock_post.return_value = httpx.Response(200, json=ollama_response, request=httpx.Request("POST", "http://localhost:11434/api/chat"))
                result = await analyze_complaint(AnalysisRequest(title="Issue", description="Details"))
                self.assertEqual(result.category, Category.payment)
                self.assertEqual(result.model_name, "ollama-llama3.2")
                openai_client.responses.create.assert_awaited_once()
                gemini_client.aio.models.generate_content.assert_awaited_once()
                mock_post.assert_awaited_once()

    async def test_all_providers_fail_returns_503(self):
        openai_client = SimpleNamespace(responses=SimpleNamespace(create=AsyncMock()))
        openai_client.responses.create.side_effect = APIConnectionError(message="network offline", request=None)

        with patch.dict(os.environ, {
            "OPENAI_API_KEY": "fake-openai-key",
            "GEMINI_API_KEY": "",
            "OLLAMA_BASE_URL": "http://localhost:11434",
            "AI_PROVIDER": "fallback",
        }, clear=False):
            with patch("app.main.get_openai_client", return_value=openai_client), \
                 patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
                mock_post.side_effect = httpx.ConnectError("Connection refused")
                with self.assertRaises(HTTPException) as caught:
                    await analyze_complaint(AnalysisRequest(title="Secret title", description="Secret description"))
                self.assertEqual(caught.exception.status_code, 503)
                self.assertNotIn("fake-openai-key", caught.exception.detail)
                self.assertNotIn("Secret", caught.exception.detail)

    async def test_ollama_direct_success_with_qwen_model(self):
        ollama_response = {
            "model": "qwen3.8:27b",
            "message": {"role": "assistant", "content": json.dumps(output_payload())},
            "done": True,
        }
        with patch.dict(os.environ, {
            "OPENAI_API_KEY": "",
            "GEMINI_API_KEY": "",
            "OLLAMA_BASE_URL": "http://host.docker.internal:11434",
            "OLLAMA_MODEL": "qwen3.8:27b",
            "AI_PROVIDER": "ollama",
        }, clear=False):
            with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
                mock_post.return_value = httpx.Response(200, json=ollama_response, request=httpx.Request("POST", "http://host.docker.internal:11434/api/chat"))
                result = await analyze_complaint(AnalysisRequest(title="Payment issue", description="Double deduction"))
                self.assertEqual(result.category, Category.payment)
                self.assertEqual(result.model_name, "ollama-qwen3.8-27b")
                mock_post.assert_awaited_once()

    async def test_ollama_missing_model_404_handled_safely(self):
        with patch.dict(os.environ, {
            "OPENAI_API_KEY": "",
            "GEMINI_API_KEY": "",
            "OLLAMA_BASE_URL": "http://host.docker.internal:11434",
            "OLLAMA_MODEL": "non-existent-model",
            "AI_PROVIDER": "ollama",
        }, clear=False):
            with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
                mock_post.return_value = httpx.Response(404, json={"error": "model 'non-existent-model' not found"}, request=httpx.Request("POST", "http://host.docker.internal:11434/api/chat"))
                with self.assertRaises(HTTPException) as caught:
                    await analyze_complaint(AnalysisRequest(title="Issue", description="Details"))
                self.assertEqual(caught.exception.status_code, 502)
                self.assertIn("not found", caught.exception.detail)

    async def test_ollama_connection_refused_returns_503(self):
        with patch.dict(os.environ, {
            "OPENAI_API_KEY": "",
            "GEMINI_API_KEY": "",
            "OLLAMA_BASE_URL": "http://host.docker.internal:11434",
            "AI_PROVIDER": "ollama",
        }, clear=False):
            with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
                mock_post.side_effect = httpx.ConnectError("Connection refused")
                with self.assertRaises(HTTPException) as caught:
                    await analyze_complaint(AnalysisRequest(title="Issue", description="Details"))
                self.assertEqual(caught.exception.status_code, 503)
                self.assertIn("temporarily unavailable", caught.exception.detail)

    def test_ollama_timeout_configuration(self):
        with patch.dict(os.environ, {"OLLAMA_TIMEOUT_SECONDS": "45.0"}, clear=False):
            t = get_ollama_timeout()
            self.assertEqual(t.connect, 10.0)
            self.assertEqual(t.read, 45.0)

        with patch.dict(os.environ, {"OLLAMA_TIMEOUT_SECONDS": "invalid"}, clear=False):
            t = get_ollama_timeout()
            self.assertEqual(t.connect, 10.0)
            self.assertEqual(t.read, 300.0)

    async def test_ollama_timeout_exception_returns_clean_504(self):
        with patch.dict(os.environ, {
            "OPENAI_API_KEY": "",
            "GEMINI_API_KEY": "",
            "OLLAMA_BASE_URL": "http://host.docker.internal:11434",
            "AI_PROVIDER": "ollama",
        }, clear=False):
            with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
                mock_post.side_effect = httpx.ReadTimeout("timed out reading response")
                with self.assertRaises(HTTPException) as caught:
                    await analyze_complaint(AnalysisRequest(title="Private billing title", description="Private card issue"))
                self.assertEqual(caught.exception.status_code, 504)
                self.assertIn("timed out", caught.exception.detail)
                self.assertNotIn("Private billing title", caught.exception.detail)
                self.assertNotIn("Private card issue", caught.exception.detail)

    async def test_missing_all_providers_configuration_returns_503(self):
        with patch.dict(os.environ, {
            "OPENAI_API_KEY": "",
            "GEMINI_API_KEY": "",
            "OLLAMA_BASE_URL": "",
            "AI_PROVIDER": "",
        }, clear=False):
            with self.assertRaises(HTTPException) as caught:
                await analyze_complaint(AnalysisRequest(title="Issue", description="Details"))
            self.assertEqual(caught.exception.status_code, 503)
            self.assertIn("not configured", caught.exception.detail)


if __name__ == "__main__":
    unittest.main()
