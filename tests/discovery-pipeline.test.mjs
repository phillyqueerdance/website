import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('Python discovery pipeline preserves media, checkpoints and delivery boundaries',()=>{
 execFileSync('python3',[fileURLToPath(new URL('./discovery_pipeline_test.py',import.meta.url))],{stdio:'pipe',timeout:180000});
});
