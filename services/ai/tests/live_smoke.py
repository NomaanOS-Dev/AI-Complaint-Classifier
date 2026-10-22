"""Opt-in live-provider smoke test. This script never runs from the normal test suite."""

import asyncio
import os

from app.main import AnalysisRequest, analyze_complaint


async def main():
    provider = os.getenv("AI_PROVIDER", "openai").strip().lower()
    if provider not in {"openai", "gemini"}:
        raise SystemExit("AI_PROVIDER must be set to 'openai' or 'gemini'.")
    enable_flag = f"RUN_{provider.upper()}_LIVE_TEST"
    if os.getenv(enable_flag) != "1":
        raise SystemExit(f"Set {enable_flag}=1 to explicitly enable a live {provider} API request.")
    key_variable = "GEMINI_API_KEY" if provider == "gemini" else "OPENAI_API_KEY"
    if not os.getenv(key_variable, "").strip():
        raise SystemExit(f"{key_variable} is required for the explicitly enabled live smoke test.")
    result = await analyze_complaint(AnalysisRequest(
        title="Payment deducted, order pending",
        description="My card was charged, but the order page still says pending and I did not receive confirmation.",
    ))
    print(f"Live {provider} analysis passed with model {result.model_name}.")


if __name__ == "__main__":
    asyncio.run(main())
