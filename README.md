# Assestant Browser

A lightweight mobile-friendly browser shell for testing the `/assestant` Claude skill from a normal web page.

## What changed

- `index.html` is now the browser interface.
- `assessment.html` preserves the original 15-question Assestant Live Test as the browser home page.
- The browser includes Back, Forward, Reload, Home, an address/search field, Go, and Open Tab.
- URLs that allow iframe embedding can be used inside the browser viewport.
- Sites that block iframe embedding can still be opened with **Open Tab**.

## Run locally

For best results, serve the folder with a local HTTP server instead of opening `index.html` as a `file://` URL.

Example with Python:

```bash
python3 -m http.server 8000
```

Then open:

```
http://localhost:8000
```

## Publish with GitHub Pages

In GitHub:

1. Open **Settings**
2. Go to **Pages**
3. Under **Build and deployment**, choose **Deploy from a branch**
4. Select **main** and **/(root)**
5. Save

The root Pages URL will open the browser interface.

## Browser limitation

This project is a web app, not a native browser engine. Modern websites can use security headers such as `X-Frame-Options` or Content Security Policy `frame-ancestors` to prevent being shown inside another webpage. When that happens, use **Open Tab** to open the address normally.
