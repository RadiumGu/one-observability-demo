# syntax=docker/dockerfile:1

FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt requirements.txt
RUN pip3 install --no-cache-dir -r requirements.txt

COPY . .
ENV FLASK_APP=petadoptionshistory
ENV PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION=python

CMD [ "flask", "run" , "--host=0.0.0.0", "--port=8080"]

EXPOSE 8080/tcp