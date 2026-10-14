# Lokalni strežnik za razvoj: kot `python3 -m http.server`, a brez predpomnjenja,
# da brskalnik po vsaki spremembi naloži svežo kodo.
#   python3 scripts/serve.py [port]
import http.server
import os
import sys


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
http.server.ThreadingHTTPServer(('127.0.0.1', port), NoCache).serve_forever()
