---
name: bug-fix
description: Reads the current iteration's bug report
---
# Bug Fix
Please go through the bug report in `.claude/agents-memory/bug-reports/report<i>.md` where `i` is the current bug-review iteration. 

Based on the documented bug, fix the bug by resolving the problematic lines highlighted in the bug report.

Once the bugfix has been made:
1. Run tests 
2. Briefly document changes and append them to the end of the bug report with the following format:
```
---
### Bug Fix Review
Reviewed by: <!-- agent-name -->
Last updated: <!-- DDMMYY HH:MM --> 
##### Changes:
<!-- **file:lines** : Brief description of changes made -->
---