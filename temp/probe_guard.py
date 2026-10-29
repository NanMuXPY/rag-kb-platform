import app.engine as eng
from app.guard import verify_citations as real_verify
from app.guard import doc_stems

calls = []


def spy(generation, documents):
    out = real_verify(generation, documents)
    calls.append((generation, sorted(doc_stems(documents)), out))
    return out


eng.verify_citations = spy

e = eng.get_engine()
r = e.ask("企微那边拿的 token 最多能撑多久啊")
print("final answer:", r["answer"][:120].replace("\n", " "))
for i, (gen, stems, out) in enumerate(calls, 1):
    print(f"\n--- 第{i}次 generate ---")
    print("原文:", gen[:260].replace("\n", " | "))
    print("白名单:", stems)
    print("校验后:", out[:80].replace("\n", " "))
