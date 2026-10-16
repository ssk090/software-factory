`mermaid.min.js` is the prebuilt browser bundle of mermaid 12.2.0 (MIT, see mermaid.LICENSE), from `dist/mermaid.min.js` of the npm package. It is vendored, not a dependency: the npm package is about 120 MB with 22 dependencies, and the dashboard needs only this file. The server serves it at `/vendor/mermaid.min.js`, and the dashboard loads it only when a document holds a diagram.

Update:

    npm pack mermaid@<version> && tar xzf mermaid-<version>.tgz
    cp package/dist/mermaid.min.js durable/dashboard/vendor/mermaid.min.js
    cp package/LICENSE durable/dashboard/vendor/mermaid.LICENSE
