"""Loopback-only ONNX cross encoder, Cohere-compatible experiment adapter."""
import argparse
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

parser = argparse.ArgumentParser()
parser.add_argument('--model-dir', required=True)
parser.add_argument('--port', type=int, default=18766)
args = parser.parse_args()
root = Path(args.model_dir).resolve()
tokenizer = Tokenizer.from_file(str(root / 'tokenizer.json'))
tokenizer.enable_truncation(max_length=512)
tokenizer.enable_padding()
options = ort.SessionOptions()
options.intra_op_num_threads = 2
session = ort.InferenceSession(str(root / 'onnx/model_quantized.onnx'), options, providers=['CPUExecutionProvider'])
inputs = {item.name for item in session.get_inputs()}

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            if self.path != '/rerank':
                self.send_error(404)
                return
            count = int(self.headers.get('Content-Length', 0))
            if count > 2000000:
                self.send_error(413)
                return
            body = json.loads(self.rfile.read(count))
            documents = body['documents']
            if not isinstance(documents, list) or len(documents) > 40:
                self.send_error(400)
                return
            scores = []
            for start in range(0, len(documents), 4):
                encoded = tokenizer.encode_batch([(body['query'], text) for text in documents[start:start + 4]])
                feed = {'input_ids': np.array([item.ids for item in encoded], dtype=np.int64),
                        'attention_mask': np.array([item.attention_mask for item in encoded], dtype=np.int64),
                        'token_type_ids': np.array([item.type_ids for item in encoded], dtype=np.int64)}
                logits = session.run(None, {key: value for key, value in feed.items() if key in inputs})[0]
                if logits.shape[-1] == 1:
                    batch_scores = 1 / (1 + np.exp(-np.clip(logits.reshape(-1), -80, 80)))
                else:
                    shifted = logits - logits.max(axis=-1, keepdims=True)
                    probabilities = np.exp(shifted) / np.exp(shifted).sum(axis=-1, keepdims=True)
                    batch_scores = probabilities[:, -1]
                scores.extend(float(value) for value in batch_scores)
            result = {'results': [{'index': index, 'relevance_score': value} for index, value in enumerate(scores)]}
            data = json.dumps(result).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as error:
            self.send_error(500, str(error))

print('Real cross-encoder listening on loopback', args.port, 'inputs:', sorted(inputs), flush=True)
HTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
