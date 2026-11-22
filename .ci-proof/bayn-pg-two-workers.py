from collections import Counter
from pathlib import Path
import sys
from xml.etree import ElementTree as ET

root = Path(sys.argv[1])
def reports(variant):
    files, cases = Counter(), Counter()
    for report in (root / variant).glob('*.xml'):
        for suite in ET.parse(report).findall('testsuite'):
            file = suite.get('file')
            files[file] += 1
            for case in suite.iter('testcase'):
                checked = tuple(c.tag for c in case)
                assert checked in ((), ('skipped',)), (file, case.get('name'), checked)
                cases[file, case.get('classname'), case.get('name'), case.get('assertions'), checked] += 1
    assert files and cases and set(files.values()) == {1}
    return files, cases
before, after = reports('base'), reports('candidate')
assert before == after, (before[0]-after[0], after[0]-before[0], before[1]-after[1], after[1]-before[1])
files, cases = before
print(len(files), 'files;', sum(cases.values()), 'cases;',
      sum(int(key[3]) * count for key, count in cases.items()), 'assertions; both variants matched')
