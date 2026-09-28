# MCP egress guard

This fail-closed pre-tool hook inspects calls to `youdede-*` MCP servers. It walks every string in the tool arguments, treats URL-like keys (`url`, `host`, `baseUrl`, `endpoint`, and similar) as destinations, and also finds `scheme://` URLs inside free text. Each destination is normalized with the WHATWG URL parser (lowercase, punycode, userinfo removed, IPv4 forms canonicalized, trailing dot and port ignored) and must equal a host in the server's `egress` from `mcp-pins.json`, which `scripts/generate-mcp.mjs` generates from each `server.json`.

## Refusals

- It refuses hosts outside the declared egress; `none` refuses every network host.
- It refuses `javascript:`, `data:`, and other unparseable destinations; `about:` passes because it has no network host.
- It refuses `file:` URLs outside the workspace; `file:` URLs inside it pass because they are local reads, not egress.
- It refuses Youdede-named servers that are absent from the registry, and malformed, oversized, or uninspectable envelopes, without echoing the destination.

## Limitations

- Servers outside the Youdede namespace pass unchecked, and a Youdede server renamed to a non-Youdede key is not recognized.
- Free-text detection only finds `scheme://` spellings; a destination built by concatenation inside code is not seen.
- The guard compares names, not DNS resolution: it does not stop a declared host that resolves or redirects elsewhere.
