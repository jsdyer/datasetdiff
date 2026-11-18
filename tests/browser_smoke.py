"""Exercise the built starter at a project subpath in Chromium."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import shutil
import tempfile
import threading
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    screenshots = ROOT / "browser-checks"
    screenshots.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as temporary:
        shutil.copytree(ROOT / "dist", Path(temporary) / "example-tool")
        server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=temporary))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch()
                page = browser.new_page(viewport={"width": 1280, "height": 1000})
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(f"http://127.0.0.1:{server.server_port}/example-tool/")
                page.locator("#sample").click()
                page.locator("#compare").click()
                page.locator("#results").wait_for()
                page.get_by_text("1–3 of 3", exact=True).wait_for()
                page.locator("#kind").select_option("changed")
                page.get_by_text('"P-101"', exact=True).click()
                assert '"Approved"' in page.locator("details[open]").inner_text()
                with page.expect_download() as download:
                    page.locator("#json").click()
                assert download.value.suggested_filename == "dataset-diff.json"
                page.locator("#old-file").set_input_files({"name":"earlier.csv","mimeType":"text/csv","buffer":b"id,status\n1,open\n1,duplicate"})
                page.locator("#new-file").set_input_files({"name":"later.csv","mimeType":"text/csv","buffer":b"id,status\n1,closed"})
                page.locator("#compare").click()
                page.get_by_text("repeats ID", exact=False).wait_for()
                assert not page.locator("#results").is_visible()
                page.locator("#clear").click()
                assert page.locator("#compare").is_disabled()
                for side, x in (("old", -63), ("new", -64)):
                    feature = {"type": "Feature", "id": "a", "properties": {"name": "Harbour"},
                               "geometry": {"type": "Point", "coordinates": [x, 44]}}
                    dataset = json.dumps({"type": "FeatureCollection", "features": [feature]}).encode()
                    page.locator("#" + side + "-file").set_input_files(
                        {"name": side + ".geojson", "mimeType": "application/geo+json", "buffer": dataset})
                page.locator("#compare").click()
                page.get_by_text('"a"', exact=True).click()
                assert "Feature · geometry" in page.locator("details[open]").inner_text()
                with page.expect_download() as geo_download:
                    page.locator("#csv").click()
                assert '"geometry"' in Path(geo_download.value.path()).read_text()
                page.locator("#clear").click()
                page.locator("#sample").click()
                page.locator("#compare").click()
                page.locator("#entries details").first.wait_for()
                page.screenshot(path=str(screenshots / "desktop.png"), full_page=True)
                page.set_viewport_size({"width": 390, "height": 844})
                overflow = page.evaluate("""
                    [...document.querySelectorAll('*')].filter(el => el.getBoundingClientRect().right > innerWidth + 1)
                      .map(el => [el.tagName, el.id, el.className, Math.round(el.getBoundingClientRect().right)])
                """)
                assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), overflow
                page.screenshot(path=str(screenshots / "mobile.png"), full_page=True)
                assert not errors, errors
                browser.close()
            print("Browser checks passed: CSV, GeoJSON geometry, validation, exports and mobile layout")
        finally:
            server.shutdown()


if __name__ == "__main__":
    main()
