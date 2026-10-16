#!/usr/bin/env python3
# Smoke-test model: `python3 tools/make-tiny-gguf.py /tmp/tiny.gguf` (needs `pip install gguf numpy`).
# Writes a tiny random-weight llama GGUF (a few MB) for a real llama.cpp smoke test. Output is gibberish by design.
import sys, numpy as np, gguf
out = sys.argv[1]
rng = np.random.default_rng(0)
n_embd, n_head, n_layer, n_ff, ctx = 64, 4, 2, 128, 512
tokens, scores, types = ["<unk>", "<s>", "</s>"], [0.0, 0.0, 0.0], [2, 3, 3]
for b in range(256):
    tokens.append(f"<0x{b:02X}>"); scores.append(0.0); types.append(6)
for i, ch in enumerate("▁abcdefghijklmnopqrstuvwxyz.,!?"):
    tokens.append(ch); scores.append(-float(i)); types.append(1)
for w in ["▁the", "▁hello", "▁ready", "▁world", "▁is", "▁a"]:
    tokens.append(w); scores.append(1.0); types.append(1)
V = len(tokens)
w = gguf.GGUFWriter(out, "llama")
w.add_name("worksuite-tiny-test"); w.add_context_length(ctx); w.add_embedding_length(n_embd)
w.add_block_count(n_layer); w.add_feed_forward_length(n_ff); w.add_head_count(n_head); w.add_head_count_kv(n_head)
w.add_rope_dimension_count(n_embd // n_head); w.add_layer_norm_rms_eps(1e-5); w.add_file_type(0)
w.add_tokenizer_model("llama"); w.add_token_list(tokens); w.add_token_scores(scores); w.add_token_types(types)
w.add_bos_token_id(1); w.add_eos_token_id(2); w.add_unk_token_id(0)
w.add_chat_template("{% for m in messages %}<s>{{ m['role'] }}: {{ m['content'] }}\n{% endfor %}{% if add_generation_prompt %}assistant:{% endif %}")
f = lambda *s: (rng.standard_normal(s) * 0.05).astype(np.float32)
w.add_tensor("token_embd.weight", f(V, n_embd)); w.add_tensor("output_norm.weight", np.ones(n_embd, np.float32)); w.add_tensor("output.weight", f(V, n_embd))
for i in range(n_layer):
    p = f"blk.{i}."
    w.add_tensor(p+"attn_norm.weight", np.ones(n_embd, np.float32)); w.add_tensor(p+"ffn_norm.weight", np.ones(n_embd, np.float32))
    for n in ["attn_q", "attn_k", "attn_v", "attn_output"]: w.add_tensor(p+n+".weight", f(n_embd, n_embd))
    w.add_tensor(p+"ffn_gate.weight", f(n_ff, n_embd)); w.add_tensor(p+"ffn_up.weight", f(n_ff, n_embd)); w.add_tensor(p+"ffn_down.weight", f(n_embd, n_ff))
w.write_header_to_file(); w.write_kv_data_to_file(); w.write_tensors_to_file(); w.close()
