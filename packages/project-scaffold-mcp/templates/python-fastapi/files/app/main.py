from fastapi import FastAPI

app = FastAPI(title="{{app_title}}")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "{{module_name}}"}
