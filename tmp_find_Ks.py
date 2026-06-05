from pathlib import Path
text = Path("js/index-BhbRKWR9.js").read_text(encoding="utf-8", errors="ignore")
for pat in ['Ks=','function Ks','const Ks=','var Ks=','jie=()=>']:
    idx = text.find(pat)
    print('PAT', pat, idx)
    if idx != -1:
        snippet = text[max(0, idx-200):idx+1200]
        print(snippet)
        print('---')
