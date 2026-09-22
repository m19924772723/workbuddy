import {appendFileSync} from 'node:fs'; appendFileSync('D:/code/workbuddy/weekly-lab/schtask-probe.txt', 'FIRED at ' + new Date().toISOString() + '\n', 'utf8');
