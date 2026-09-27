"""Dev-only HTTPS static server for testing the web sender on a real phone.

Browsers only expose getUserMedia/mediaDevices on a "secure context":
https://, or http://localhost specifically — a plain http:// LAN IP does
not qualify, even on the same network. Since the phone must reach this by
LAN IP (it isn't the localhost machine), this wraps the same static file
serving in a self-signed TLS cert (see gen_cert.sh) instead.

Usage: python https_server.py <port> <cert.pem> <key.pem>
"""

import http.server
import ssl
import sys

port = int(sys.argv[1])
certfile = sys.argv[2]
keyfile = sys.argv[3]

handler = http.server.SimpleHTTPRequestHandler
httpd = http.server.ThreadingHTTPServer(("0.0.0.0", port), handler)

ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(certfile=certfile, keyfile=keyfile)
httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)

print(f"Serving HTTPS on 0.0.0.0:{port}")
httpd.serve_forever()
