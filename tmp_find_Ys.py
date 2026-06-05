from pathlib import Path
import re
text = Path('js/index-BhbRKWR9.js').read_text(encoding='utf-8', errors='ignore')
for pat in ['Ys=', 'function Ys', 'const Ys=', 'var Ys=']:
    idx = text.find(pat)
    print('PAT', pat, idx)
    if idx != -1:
        print(text[max(0, idx-120):idx+600])
        print('---')
