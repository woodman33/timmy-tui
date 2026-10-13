# Build the web starter

`/run BUILD.md build` copies the page and `src/` into `dist/`. After that, `/preview` serves the built
`dist/`; before it, `/preview` runs the development server (`npm run dev`).

```bash [name:build]
rm -rf dist && mkdir -p dist && cp -R index.html src dist/ && echo "built dist/"
```
