"""Explicit local experiment adapter; no download, no application dependency."""
import argparse
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

parser = argparse.ArgumentParser()
parser.add_argument('--model-dir', required=True)
parser.add_argument('--port', type=int, default=18765)
parser.add_argument('--model-file', default='model_quantized.onnx')
args = parser.parse_args()
root = Path(args.model_dir).resolve()
tokenizer = Tokenizer.from_file(str(root / 'tokenizer.json'))
tokenizer.enable_truncation(max_length=512)
tokenizer.enable_padding()
options = ort.SessionOptions()
options.intra_op_num_threads = 2
session = ort.InferenceSession(str(root / 'onnx' / args.model_file), options,
                              providers=['CPUExecutionProvider'])
inputs = {item.name for item in session.get_inputs()}

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            if self.path != '/v1/embeddings':
                self.send_error(404)
                return
            count = int(self.headers.get('Content-Length', 0))
            if count > 2_000_000:
                self.send_error(413)
                return
            body = json.loads(self.rfile.read(count))
            texts = body['input']
            if isinstance(texts, str):
                texts = [texts]
            encoded = tokenizer.encode_batch(texts)
            ids = np.array([item.ids for item in encoded], dtype=np.int64)
            mask = np.array([item.attention_mask for item in encoded], dtype=np.int64)
            feed = {'input_ids': ids, 'attention_mask': mask,
                    'token_type_ids': np.array([item.type_ids for item in encoded], dtype=np.int64)}
            output = session.run(None, {key: value for key, value in feed.items() if key in inputs})[0]
            if output.ndim == 3:
                expanded = mask[:, :, None]
                output = (output * expanded).sum(axis=1) / np.maximum(expanded.sum(axis=1), 1)
            output = output / np.maximum(np.linalg.norm(output, axis=1, keepdims=True), 1e-12)
            result = {'data': [{'index': i, 'embedding': vector.tolist()} for i, vector in enumerate(output)]}
            data = json.dumps(result).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as error:
            self.send_error(500, str(error))

print('Local ONNX experiment listening on loopback', args.port, flush=True)
HTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
