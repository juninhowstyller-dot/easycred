from pathlib import Path
p = Path('js/index-BhbRKWR9.js')
text = p.read_text(encoding='utf-8', errors='ignore')
for term in ['jie=()=>g.jsx(Aie', 'Aie=({children:e})=>', 'const Yi=', 'Tie=({children:e})=>']:
    idx = text.find(term)
    print('TERM:', term, 'IDX:', idx)
    if idx != -1:
        start = max(0, idx - 800)
        end = min(len(text), idx + 1600)
        snippet = text[start:end]
        print(snippet)
        print('\n' + '-'*80 + '\n')
