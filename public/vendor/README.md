# Marked 18.0.11

`marked-18.0.11.esm.js` is an unchanged copy of `lib/marked.esm.js` from the
existing locked `marked@18.0.11` installation. This is a browser ESM module; no
runtime CDN or new package dependency is used.

- Project: https://github.com/markedjs/marked
- Documentation: https://marked.js.org/using_pro#lexer
- npm tarball: https://registry.npmjs.org/marked/-/marked-18.0.11.tgz
- Lockfile integrity: `sha512-HnslJfsZkRPBDJRHvVtAaWlZHEpSu7u8LgQuJCELjRKuWR+hpq4A7sLq3p8HaI9ypVoXDXxV34CsQJEe1+J5Aw==`
- Vendored module SHA-256: `05e41134d075ad3a009a748d6c779c3d83cea9b942be911c2d9abade36d1dd31`
- License: MIT; see `marked-18.0.11.LICENSE.txt` for the complete upstream notice.
- The upstream `marked.esm.js.map` is included for browser developer tools, with SHA-256 `2140b1d34433b175421ca86d8d847e429a48556cc40be7b853e45d697699335a`.

JEFF uses only its lexer. `public/markdown.js` builds an allowlisted DOM tree
from tokens, treats HTML as literal text, disables image elements, and allows
only explicit HTTP/HTTPS links. Marked's HTML parser output is never inserted.
