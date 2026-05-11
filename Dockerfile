FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    VLLM_OMNI_BASE_URL=http://host.docker.internal:8000 \
    VOXCPM2_MODEL=openbmb/VoxCPM2 \
    VLLM_OMNI_API_KEY=EMPTY

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY README.md .

EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]

