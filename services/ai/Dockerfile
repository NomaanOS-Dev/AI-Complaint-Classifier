FROM python:3.12-slim
WORKDIR /app
COPY services/ai/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY services/ai/app ./app
COPY services/ai/tests ./tests
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
