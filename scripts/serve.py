#!/usr/bin/env python3
"""Local server that never lets the browser cache (always the latest code and data).
   python3 scripts/serve.py  ->  http://localhost:8080"""
import http.server, os, sys
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, max-age=0')
        super().end_headers()
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(('0.0.0.0', int(sys.argv[1]) if len(sys.argv) > 1 else 8080), H).serve_forever()
