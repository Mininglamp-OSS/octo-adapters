import {mkdtempSync,readFileSync,readdirSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./mcp-deployment.js', () => ({ BUNDLED_MCP_URL: 'https://release.example/mcp/' }));
vi.mock('./openclaw-cli.js', () => ({getOpenClawVersion: vi.fn(() => '2026.10.5'), getConfigFilePathSafe: vi.fn(), readConfigFromFile: vi.fn(), writeConfigAtomic: vi.fn(), runOpenclaw: vi.fn(), gatewayStatus: vi.fn(() => ({running:false})), gatewayRestart:vi.fn()}));
vi.mock('./utils.js', async importOriginal => ({...await importOriginal<any>(), enforceHealthyClawHubInstall:vi.fn()}));
vi.mock('./mcp-probe.js', () => ({probeOctoMcp:vi.fn()}));
import { getConfigFilePathSafe, readConfigFromFile, writeConfigAtomic, runOpenclaw, gatewayStatus } from './openclaw-cli.js';
import {probeOctoMcp} from './mcp-probe.js';
import {runBind} from './bind.js';
import {runQuickstart} from './quickstart.js';
describe('release-bundled endpoint at binding entry points', () => {
 beforeEach(() => {vi.clearAllMocks();vi.useFakeTimers();vi.spyOn(console,'log').mockImplementation(()=>{});vi.mocked(readConfigFromFile).mockReturnValue({agents:{entries:{main:{}}}});vi.mocked(runOpenclaw).mockReturnValue('[{"id":"main","name":"main"}]');vi.mocked(probeOctoMcp).mockResolvedValue({tools:['get_skill','execute']});vi.stubGlobal('fetch',vi.fn(async (url:string) => new Response(JSON.stringify(url.endsWith('/v1/user/bots') ? {robot_id:'new_bot',bot_token:'bf_new',name:'New'} : {name:'New'}),{status:200})));});
 afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
 it('reports a saved bind despite an unknown Gateway state', async()=>{
   vi.mocked(gatewayStatus).mockReturnValueOnce({running:false,stateUnknown:true});
   const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
   const run=runBind({botToken:'bf_new',accountId:'new_bot',apiUrl:'http://localhost',agent:'main'});
   const outcome=expect(run).resolves.toBeUndefined(); await vi.runAllTimersAsync(); await outcome;
   expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/configured and bound/));
   expect(warn).toHaveBeenCalledWith(expect.stringMatching(/saved.*status.*unknown/i));
 });
 it('bind probes the release URL without an endpoint flag', async()=>{const run=runBind({botToken:'bf_new',accountId:'new_bot',apiUrl:'http://localhost',agent:'main'});await vi.runAllTimersAsync();await run;expect(probeOctoMcp).toHaveBeenCalledWith('https://release.example/mcp/','bf_new');expect(writeConfigAtomic).toHaveBeenCalledWith(expect.objectContaining({bindings:expect.any(Array)}),{agents:{entries:{main:{}}}});});
 it('bind compares an absent file rather than disabling the write guard', async()=>{vi.mocked(readConfigFromFile).mockReturnValue(undefined);const run=runBind({botToken:'bf_new',accountId:'new_bot',apiUrl:'http://localhost',agent:'main'});await vi.runAllTimersAsync();await run;expect(writeConfigAtomic).toHaveBeenCalledWith(expect.any(Object),null);});
 it('quickstart saves issued credentials before a failed release probe', async()=>{vi.mocked(probeOctoMcp).mockRejectedValue(new Error('offline'));await expect(runQuickstart({apiKey:'uk_fixture',apiUrl:'http://localhost'})).rejects.toThrow(/credentials saved.*do not rerun/i);expect(writeConfigAtomic).toHaveBeenCalledTimes(1);expect(writeConfigAtomic).toHaveBeenCalledWith(expect.objectContaining({channels:{octo:expect.objectContaining({accounts:{new_bot:expect.objectContaining({botToken:'bf_new'})}})}}),{agents:{entries:{main:{}}}});expect(vi.mocked(writeConfigAtomic).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(probeOctoMcp).mock.invocationCallOrder[0]);expect(fetch).toHaveBeenCalledTimes(1);});
 it('retains issued credentials when a concurrent edit rejects the write', async()=>{
   const dir=mkdtempSync(join(tmpdir(),'octo-quickstart-cas-'));
   try {
    vi.mocked(getConfigFilePathSafe).mockReturnValue(join(dir,'openclaw.json'));
    vi.mocked(writeConfigAtomic).mockImplementationOnce(()=>{throw new Error('configuration changed; retry');});
    await expect(runQuickstart({apiKey:'uk_fixture',apiUrl:'http://localhost'})).rejects.toThrow(/Credentials retained.*Do not rerun quickstart/);
    const files=readdirSync(dir);expect(files).toHaveLength(1);
    const recovery=join(dir,files[0]);expect(statSync(recovery).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(recovery,'utf8')).bots[0]).toMatchObject({robotId:'new_bot',botToken:'bf_new'});
    expect(fetch).toHaveBeenCalledTimes(1);expect(probeOctoMcp).not.toHaveBeenCalled();expect(writeConfigAtomic).toHaveBeenCalledTimes(1);
   } finally {rmSync(dir,{recursive:true,force:true});}
 });
 it('quickstart uses the release URL and preserves its comparison snapshot', async()=>{const source={agents:{entries:{main:{}}}};vi.mocked(readConfigFromFile).mockReturnValue(source);const run=runQuickstart({apiKey:'uk_fixture',apiUrl:'http://localhost'});await vi.runAllTimersAsync();await run;expect(source).toEqual({agents:{entries:{main:{}}}});expect(probeOctoMcp).toHaveBeenCalledWith('https://release.example/mcp/','bf_new');expect(writeConfigAtomic).toHaveBeenCalledWith(expect.any(Object),source);});
});
