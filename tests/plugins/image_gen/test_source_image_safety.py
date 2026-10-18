"""F12: image-edit source images. The agent passes a path or URL that may come
from an untrusted message ("edit the picture at ~/.hermes/.env" or
"http://169.254.169.254/latest/meta-data/"). Only real images are read, and
only public addresses are fetched; real local image edits keep working."""

import base64
from unittest.mock import MagicMock, patch

import pytest

from agent import image_gen_provider as igp
from plugins.image_gen.openai import _load_image_bytes
from plugins.image_gen.xai import _xai_image_field

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 32


@pytest.fixture(autouse=True)
def _home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes"))
    monkeypatch.setenv("HOME", str(tmp_path))


def _resp(status=200, body=b"", location=None):
    r = MagicMock()
    r.status_code = status
    r.is_redirect = location is not None
    r.headers = {"location": location} if location else {}
    r.iter_content.return_value = [body]
    r.raise_for_status.return_value = None
    return r


# --- local files ------------------------------------------------------------


def test_local_image_still_loads(tmp_path):
    img = tmp_path / "photo.png"
    img.write_bytes(PNG)
    assert _load_image_bytes(str(img)) == (PNG, "photo.png")
    assert _load_image_bytes("~/photo.png") == (PNG, "photo.png")


@pytest.mark.parametrize("loader", [_load_image_bytes, _xai_image_field])
def test_local_secret_file_is_refused(tmp_path, loader):
    secret = tmp_path / ".env"
    secret.write_text("OPENAI_API_KEY=sk-should-not-leave-the-box\n")
    with pytest.raises(ValueError, match="not a PNG"):
        loader(str(secret))


def test_secret_renamed_to_png_is_still_refused(tmp_path):
    fake = tmp_path / "key.png"
    fake.write_text("-----BEGIN OPENSSH PRIVATE KEY-----\n")
    with pytest.raises(ValueError, match="not a PNG"):
        _load_image_bytes(str(fake))


def test_xai_local_image_becomes_data_uri_with_real_type(tmp_path):
    img = tmp_path / "pic.png"  # wrong extension on purpose
    img.write_bytes(JPEG)
    field = _xai_image_field(str(img))
    assert field["url"].startswith("data:image/jpeg;base64,")


# --- data: URIs ---------------------------------------------------------------


def test_data_uri_must_be_an_image():
    ok = "data:image/png;base64," + base64.b64encode(PNG).decode()
    assert _load_image_bytes(ok) == (PNG, "image.png")
    bad = "data:image/png;base64," + base64.b64encode(b"not an image").decode()
    with pytest.raises(ValueError):
        _load_image_bytes(bad)


# --- URLs ---------------------------------------------------------------------


@pytest.mark.parametrize("url", [
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:8642/v1/models",
    "http://localhost:3000/",
    "http://10.0.0.5/admin.png",
])
def test_private_urls_are_refused_without_a_request(url):
    with patch("requests.get") as get:
        with pytest.raises(ValueError, match="not allowed"):
            _load_image_bytes(url)
    get.assert_not_called()


def test_public_url_image_loads():
    with patch("tools.url_safety.is_safe_url", return_value=True), \
         patch("requests.get", return_value=_resp(body=PNG)) as get:
        data, name = _load_image_bytes("https://cdn.example.com/a/cat.png?x=1")
    assert (data, name) == (PNG, "cat.png")
    assert get.call_args.kwargs["allow_redirects"] is False


def test_redirect_to_private_address_is_refused():
    def _safe(url):
        return "169.254" not in url

    with patch("tools.url_safety.is_safe_url", side_effect=_safe), \
         patch("requests.get", return_value=_resp(302, location="http://169.254.169.254/x")) as get:
        with pytest.raises(ValueError, match="not allowed"):
            _load_image_bytes("https://public.example.com/img.png")
    assert get.call_count == 1


def test_url_that_is_not_an_image_is_refused():
    with patch("tools.url_safety.is_safe_url", return_value=True), \
         patch("requests.get", return_value=_resp(body=b"<html>hi</html>")):
        with pytest.raises(ValueError, match="did not return"):
            _load_image_bytes("https://public.example.com/page")


def test_oversized_download_is_refused(monkeypatch):
    monkeypatch.setattr(igp, "MAX_SOURCE_IMAGE_BYTES", 10)
    with patch("tools.url_safety.is_safe_url", return_value=True), \
         patch("requests.get", return_value=_resp(body=PNG)):
        with pytest.raises(ValueError, match="larger than"):
            _load_image_bytes("https://public.example.com/big.png")
