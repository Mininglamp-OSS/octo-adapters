import {describe,it,expect,vi,beforeEach} from 'vitest';
vi.mock('./openclaw-cli.js',()=>({getOpenClawVersion:vi.fn(()=>'2026.10.5'),readConfigFromFile:vi.fn(),writeConfigAtomic:vi.fn(),gatewayStatus:vi.fn(()=>({running:false})),gatewayRestart:vi.fn()}));
vi.mock('./mcp-probe.js',()=>({probeOctoMcp:vi.fn()}));
import {configureOctoMcp,resolveMcpAccount} from './mcp-config.js';
import {checkMcpConfig} from './mcp.js';
import {probeOctoMcp} from './mcp-probe.js';
function config():any{return {channels:{octo:{accounts:{a:{botToken:'bf_a'},b:{botToken:'bf_b'}}}},agents:{entries:{alice:{tools:{deny:['octo-mcp__search_ops']}},bob:{tools:{deny:['octo-mcp__execute']}}}},bindings:[{agentId:'alice',match:{channel:'octo',accountId:'a'}},{agentId:'bob',match:{channel:'octo',accountId:'b'}}],mcp:{servers:{'octo-mcp':{transport:'streamable-http',url:'https://mcp.test/'}}}};}
describe('review regressions: scoped identity and inherited permissions',()=>{
 beforeEach(()=>vi.clearAllMocks());
 it('checks each account against its own discovered facade',async()=>{vi.mocked(probeOctoMcp).mockImplementation(async(_url,token)=>({tools:token==='bf_a'?['get_skill','execute']:['search_ops','describe_op','call_op']}));await expect(checkMcpConfig(config())).resolves.toBeUndefined();});
 it('keeps global additive policy inherited across changes',()=>{const c=config();delete c.agents.entries.alice.tools.deny;delete c.agents.entries.bob.tools.deny;c.tools={profile:'coding',alsoAllow:['temporary_tool']};const first=configureOctoMcp(c);expect(first.config.agents.entries.alice.tools.alsoAllow).toBeUndefined();first.config.tools.alsoAllow=['new_tool'];const next=configureOctoMcp(first.config);expect(next.config.agents.entries.alice.tools.alsoAllow).toBeUndefined();expect(next.config.tools.alsoAllow).toEqual(['new_tool']);});
 it('matches legacy account keys using the host canonical identity',()=>{const c=config();c.channels.octo.accounts={'My Bot':{botToken:'bf_a'}};c.bindings=[{agentId:'alice',match:{channel:'octo',accountId:'my-bot'}}];const next=configureOctoMcp(c);expect(next.agentIds).toEqual(['alice']);expect(next.warnings).toBeUndefined();});
 it.each(['constructor','prototype','__proto__'])('refuses host-blocked account %s',id=>{const c=config();c.channels.octo.accounts=JSON.parse(JSON.stringify({[id]:{botToken:'bf_blocked'}}));expect(resolveMcpAccount(c,id)).toBeUndefined();});
 it('rejects canonical account collisions',()=>{const c=config();c.channels.octo.accounts={'My Bot':{botToken:'bf_a'},'my-bot':{botToken:'bf_b'}};c.bindings=[{agentId:'alice',match:{channel:'octo',accountId:'my-bot'}}];expect(()=>configureOctoMcp(c)).toThrow(/ambiguous/i);});
 it('preserves disabled channels without enabling or asserting policy',()=>{const c=config();c.channels.octo.enabled=false;c.tools={allow:['read']};const out=configureOctoMcp(c,'https://new.test/');expect(out.enabled).toBe(false);expect(out.config.mcp).toEqual(c.mcp);expect(out.config.agents).toEqual(c.agents);});
 it.each(['allow','deny','alsoAllow'])('rejects malformed Agent %s before saving',key=>{const c=config();c.agents.entries.alice.tools[key]='read';expect(()=>configureOctoMcp(c)).toThrow(/malformed.*policy/i);});
 it.each(['bundle-mcp',[1]])('rejects malformed denial %j',deny=>{const c=config();c.tools={deny};expect(()=>configureOctoMcp(c)).toThrow(/malformed.*policy/i);});
});
