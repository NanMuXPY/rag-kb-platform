import app.engine as eng
from app.guard import verify_citations as real_verify, doc_stems

calls = []


def spy(generation, documents):
    out = real_verify(generation, documents)
    calls.append((generation, sorted(doc_stems(documents)), out))
    return out


eng.verify_citations = spy
e = eng.get_engine()
q = "服务器能 ping 通外网 IP，但装东西全部超时"
r = e.ask(q)
print("trace:", " -> ".join(f"{t['node']}({t.get('note','')})" for t in r["trace"]))
print("final:", r["answer"][:60].replace("\n", " "))
for i, (gen, stems, out) in enumerate(calls, 1):
    tail = gen[-160:].replace("\n", " | ")
    print(f"\n[generate {i}] 校验后长度={len(out)}")
    print("结尾原文:", tail)
    print("白名单:", stems)
