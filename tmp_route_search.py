from pathlib import Path
data = Path('js/index-BhbRKWR9.js').read_text(encoding='utf-8', errors='ignore')
patterns=['/maquininhas','/vendas','/cartoes','/parcelamento','/funcionarios','path:"/maquininhas"']
for pat in patterns:
    idx = data.find(pat)
    if idx != -1:
        start = max(0, idx-200)
        end = idx + len(pat) + 200
        print(pat, idx)
        print(data[start:end])
