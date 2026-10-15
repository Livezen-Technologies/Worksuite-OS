"""Minimal greetd IPC client (https://man.sr.ht/~kennylevinsen/greetd/ "greetd-ipc(7)").

Each message is a 32-bit native-endian length followed by that many bytes of UTF-8 JSON.
"""
import json
import os
import socket
import struct


class GreetdError(Exception):
    pass


class Greetd:
    def __init__(self, path=None, sock=None):
        if sock is None:
            path = path or os.environ.get("GREETD_SOCK")
            if not path:
                raise GreetdError("GREETD_SOCK is not set")
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.connect(path)
        self.sock = sock

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass

    def _recv_exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise GreetdError("greetd closed the connection")
            buf += chunk
        return buf

    def request(self, msg):
        data = json.dumps(msg).encode("utf-8")
        self.sock.sendall(struct.pack("=I", len(data)) + data)
        (length,) = struct.unpack("=I", self._recv_exact(4))
        if length > 1 << 20:
            raise GreetdError("reply too large")
        return json.loads(self._recv_exact(length).decode("utf-8"))

    def create_session(self, username):
        return self.request({"type": "create_session", "username": username})

    def respond(self, response):
        return self.request({"type": "post_auth_message_response", "response": response})

    def start_session(self, cmd, env=()):
        return self.request({"type": "start_session", "cmd": list(cmd), "env": list(env)})

    def cancel_session(self):
        return self.request({"type": "cancel_session"})
