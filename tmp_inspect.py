from pathlib import Path
text = Path('js/index-BhbRKWR9.js').read_text(encoding='utf-8', errors='ignore')
idx = text.find('localStorage.getItem("selectedCompany")')
print(idx)
print(text[max(0, idx-400):idx+700])
