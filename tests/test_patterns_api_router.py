import os
import tempfile
from collections.abc import Generator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import getgather.patterns_api_router as patterns_module
from getgather.patterns_api_router import router


@pytest.fixture
def patterns_dir() -> Generator[str, None, None]:
    with tempfile.TemporaryDirectory() as d:
        yield d


@pytest.fixture
def client(patterns_dir: str, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(patterns_module, "PATTERNS_DIR", patterns_dir)
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


class TestListPatterns:
    def test_empty_directory(self, client: TestClient) -> None:
        response = client.get("/api/v1/patterns")
        assert response.status_code == 200
        assert response.json() == []

    def test_returns_sorted_names(self, client: TestClient, patterns_dir: str) -> None:
        for name in ["zebra", "alpha", "middle"]:
            open(os.path.join(patterns_dir, f"{name}.html"), "w").close()
        response = client.get("/api/v1/patterns")
        assert response.status_code == 200
        assert response.json() == ["alpha.html", "middle.html", "zebra.html"]

    def test_includes_html_and_json(self, client: TestClient, patterns_dir: str) -> None:
        open(os.path.join(patterns_dir, "amazon.html"), "w").close()
        open(os.path.join(patterns_dir, "amazon.json"), "w").close()
        open(os.path.join(patterns_dir, "goodreads.html"), "w").close()
        response = client.get("/api/v1/patterns")
        assert response.json() == ["amazon.html", "amazon.json", "goodreads.html"]

    def test_ignores_unsupported_files(self, client: TestClient, patterns_dir: str) -> None:
        open(os.path.join(patterns_dir, "valid.html"), "w").close()
        open(os.path.join(patterns_dir, "data.json"), "w").close()
        open(os.path.join(patterns_dir, "ignore.txt"), "w").close()
        open(os.path.join(patterns_dir, "ignore.py"), "w").close()
        response = client.get("/api/v1/patterns")
        assert response.json() == ["data.json", "valid.html"]


class TestGetPattern:
    def test_returns_html_content(self, client: TestClient, patterns_dir: str) -> None:
        path = os.path.join(patterns_dir, "example.html")
        with open(path, "w") as f:
            f.write("<div>hello</div>")
        response = client.get("/api/v1/patterns/example")
        assert response.status_code == 200
        assert response.text == "<div>hello</div>"
        assert "text/html" in response.headers["content-type"]

    def test_returns_json_content(self, client: TestClient, patterns_dir: str) -> None:
        path = os.path.join(patterns_dir, "converter.json")
        with open(path, "w") as f:
            f.write('{"rows": "tr"}')
        response = client.get("/api/v1/patterns/converter?ext=json")
        assert response.status_code == 200
        assert response.text == '{"rows": "tr"}'
        assert "application/json" in response.headers["content-type"]

    def test_not_found(self, client: TestClient) -> None:
        response = client.get("/api/v1/patterns/missing")
        assert response.status_code == 404

    def test_not_found_json(self, client: TestClient) -> None:
        response = client.get("/api/v1/patterns/missing?ext=json")
        assert response.status_code == 404

    def test_invalid_name_rejected(self, client: TestClient) -> None:
        response = client.get("/api/v1/patterns/bad%20name")
        assert response.status_code == 400

    def test_invalid_name_with_slash(self, client: TestClient) -> None:
        response = client.get("/api/v1/patterns/foo/bar")
        assert response.status_code == 404

    def test_invalid_name_with_dots(self, client: TestClient) -> None:
        response = client.get("/api/v1/patterns/foo.bar")
        assert response.status_code == 400

    def test_invalid_ext_rejected(self, client: TestClient) -> None:
        response = client.get("/api/v1/patterns/example?ext=xml")
        assert response.status_code == 400

    def test_html_and_json_are_independent(self, client: TestClient, patterns_dir: str) -> None:
        with open(os.path.join(patterns_dir, "dual.html"), "w") as f:
            f.write("<p>html</p>")
        with open(os.path.join(patterns_dir, "dual.json"), "w") as f:
            f.write('{"key": "val"}')
        html_resp = client.get("/api/v1/patterns/dual")
        json_resp = client.get("/api/v1/patterns/dual?ext=json")
        assert html_resp.text == "<p>html</p>"
        assert json_resp.text == '{"key": "val"}'


class TestUpsertPattern:
    def test_create_new_pattern(self, client: TestClient, patterns_dir: str) -> None:
        response = client.post("/api/v1/patterns/new-pattern", json={"content": "<p>test</p>"})
        assert response.status_code == 200
        data = response.json()
        assert data["pattern_name"] == "new-pattern"
        assert data["status"] == "created"
        assert os.path.isfile(os.path.join(patterns_dir, "new-pattern.html"))

    def test_file_content_written(self, client: TestClient, patterns_dir: str) -> None:
        client.post("/api/v1/patterns/mypattern", json={"content": "<span>hi</span>"})
        with open(os.path.join(patterns_dir, "mypattern.html")) as f:
            assert f.read() == "<span>hi</span>"

    def test_update_existing_pattern(self, client: TestClient, patterns_dir: str) -> None:
        path = os.path.join(patterns_dir, "existing.html")
        with open(path, "w") as f:
            f.write("old")
        response = client.post("/api/v1/patterns/existing", json={"content": "new"})
        assert response.status_code == 200
        assert response.json()["status"] == "updated"
        with open(path) as f:
            assert f.read() == "new"

    def test_create_json_pattern(self, client: TestClient, patterns_dir: str) -> None:
        response = client.post(
            "/api/v1/patterns/converter?ext=json",
            json={"content": '{"rows": "tr", "columns": ["name"]}'},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["pattern_name"] == "converter"
        assert data["status"] == "created"
        path = os.path.join(patterns_dir, "converter.json")
        assert os.path.isfile(path)
        with open(path) as f:
            assert f.read() == '{"rows": "tr", "columns": ["name"]}'

    def test_update_json_pattern(self, client: TestClient, patterns_dir: str) -> None:
        path = os.path.join(patterns_dir, "data.json")
        with open(path, "w") as f:
            f.write('{"old": true}')
        response = client.post("/api/v1/patterns/data?ext=json", json={"content": '{"new": true}'})
        assert response.status_code == 200
        assert response.json()["status"] == "updated"
        with open(path) as f:
            assert f.read() == '{"new": true}'

    def test_invalid_name_rejected(self, client: TestClient) -> None:
        response = client.post("/api/v1/patterns/bad name!", json={"content": "x"})
        assert response.status_code == 400

    def test_invalid_ext_rejected(self, client: TestClient) -> None:
        response = client.post("/api/v1/patterns/test?ext=xml", json={"content": "<x/>"})
        assert response.status_code == 400

    def test_html_and_json_independent(self, client: TestClient, patterns_dir: str) -> None:
        client.post("/api/v1/patterns/dual", json={"content": "<p>html</p>"})
        client.post("/api/v1/patterns/dual?ext=json", json={"content": '{"k":"v"}'})
        with open(os.path.join(patterns_dir, "dual.html")) as f:
            assert f.read() == "<p>html</p>"
        with open(os.path.join(patterns_dir, "dual.json")) as f:
            assert f.read() == '{"k":"v"}'


class TestDeletePattern:
    def test_delete_existing_pattern(self, client: TestClient, patterns_dir: str) -> None:
        path = os.path.join(patterns_dir, "todelete.html")
        open(path, "w").close()
        response = client.delete("/api/v1/patterns/todelete")
        assert response.status_code == 200
        data = response.json()
        assert data["pattern_name"] == "todelete"
        assert data["status"] == "deleted"
        assert not os.path.exists(path)

    def test_delete_json_pattern(self, client: TestClient, patterns_dir: str) -> None:
        path = os.path.join(patterns_dir, "converter.json")
        open(path, "w").close()
        response = client.delete("/api/v1/patterns/converter?ext=json")
        assert response.status_code == 200
        data = response.json()
        assert data["pattern_name"] == "converter"
        assert data["status"] == "deleted"
        assert not os.path.exists(path)

    def test_delete_nonexistent_pattern(self, client: TestClient) -> None:
        response = client.delete("/api/v1/patterns/ghost")
        assert response.status_code == 404

    def test_delete_nonexistent_json_pattern(self, client: TestClient) -> None:
        response = client.delete("/api/v1/patterns/ghost?ext=json")
        assert response.status_code == 404

    def test_invalid_name_rejected(self, client: TestClient) -> None:
        response = client.delete("/api/v1/patterns/bad%21name")
        assert response.status_code == 400

    def test_invalid_ext_rejected(self, client: TestClient) -> None:
        response = client.delete("/api/v1/patterns/test?ext=xml")
        assert response.status_code == 400

    def test_delete_html_does_not_affect_json(self, client: TestClient, patterns_dir: str) -> None:
        html_path = os.path.join(patterns_dir, "dual.html")
        json_path = os.path.join(patterns_dir, "dual.json")
        open(html_path, "w").close()
        open(json_path, "w").close()
        client.delete("/api/v1/patterns/dual")
        assert not os.path.exists(html_path)
        assert os.path.exists(json_path)
