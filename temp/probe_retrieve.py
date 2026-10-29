from app.engine import get_engine

e = get_engine()
q = "企业微信 access_token 的有效期是多久"
where = {"kb_id": {"$in": ["default"]}}
docs = e.db.similarity_search(q, k=4, filter=where)
print("chunks in store:", e.db._collection.count())
for i, d in enumerate(docs, 1):
    t = d.page_content or ""
    print(i, (d.metadata or {}).get("source", "")[-42:], "| len", len(t), "| 含7200:", "7200" in t)
    print("   ", t[:100].replace("\n", " "))

print("\n--- hybrid 通道 ---")
from app.retrieval import bm25_search
bm = bm25_search(e.db, q, 4, ["default"])
for i, d in enumerate(bm, 1):
    t = d.page_content or ""
    print(i, (d.metadata or {}).get("source", "")[-42:], "| 含7200:", "7200" in t)
