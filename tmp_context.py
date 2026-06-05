from pathlib import Path
data = Path('js/index-BhbRKWR9.js').read_text(encoding='utf-8', errors='ignore')
idx = data.find('/maquininhas')
print('idx', idx)
print(data[max(0, idx-500):idx+500])
