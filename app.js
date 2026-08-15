const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const SPEED_LANE_VERSION='max-speed-v2';
if(localStorage.getItem('speedLaneVersion')!==SPEED_LANE_VERSION){localStorage.setItem('pollInterval','0.5');localStorage.setItem('speedLaneVersion',SPEED_LANE_VERSION)}
const state={gameId:null,game:null,plays:[],eventSource:null,filter:'all',order:localStorage.getItem('playOrder')||'newest',rawKind:'scoreboard',rawText:'',lastCheck:null,lastNewPlay:null,resolution:{},fastcastStatus:'connecting',feedFrame:null,csvUrl:null};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const api=async(url,options={})=>{const response=await fetch(url,options);if(!response.ok)throw new Error(`${response.status} ${await response.text()}`);return response.json()};
const fmtAgo=iso=>{if(!iso)return '—';const s=Math.max(0,(Date.now()-new Date(iso))/1000);return s<60?`${s.toFixed(1)} sec ago`:s<3600?`${Math.floor(s/60)} min ago`:`${Math.floor(s/3600)} hr ago`};
const fmtTime=iso=>iso?new Date(iso).toLocaleTimeString([],{hour:'numeric',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3}):'—';
const fmtMs=v=>v==null?'—':`${Number(v).toFixed(v<10?2:1)} ms`;
const numberText=text=>esc(text).replace(/#(\?|\d+[A-Z]?)(?=\s)/g,(_,n)=>`<span class="jersey ${n==='?'?'unknown':''}">#${n}</span>`);

function page(name){
  $$('.page').forEach(p=>p.classList.remove('active')); $(`#${name}Page`)?.classList.add('active');
  $$('.bottom-nav button').forEach(b=>b.classList.toggle('active',b.dataset.page===name));
  if(name==='lab')loadLatency(); if(name==='debug')loadRaw(state.rawKind); if(name==='history')loadHistory(); if(name==='access')loadAccess();
  if(name==='game'&&!state.gameId)page('games'); window.scrollTo(0,0);
}
$$('[data-page]').forEach(b=>b.addEventListener('click',()=>page(b.dataset.page)));

async function loadGames(dates){
  $('#gamesList').innerHTML='<div class="skeleton card"></div>'; $('#gamesMeta').textContent='Checking ESPN…';
  try{const data=await api(`/api/games${dates?`?dates=${dates}`:''}`);renderGames(data.games);$('#gamesMeta').textContent=`${data.games.length} games • ESPN checked in ${data.request_ms.toFixed(0)} ms${data.error?' • cached data':''}`}
  catch(e){$('#gamesMeta').textContent=`Scoreboard unavailable: ${e.message}`;$('#gamesList').innerHTML='<div class="card" style="padding:16px">ESPN could not be reached. Try again in a moment.</div>'}
}
function renderGames(games){
  $('#gamesList').innerHTML=games.length?games.map(g=>`<button class="game-card" data-game='${esc(JSON.stringify(g))}'>
    <span class="teams"><span class="mini-team"><img src="${esc(g.away.logo||'')}" alt=""><b>${esc(g.away.abbreviation)}</b><span class="score">${esc(g.away.score)}</span></span>
    <span class="mini-team"><img src="${esc(g.home.logo||'')}" alt=""><b>${esc(g.home.abbreviation)}</b><span class="score">${esc(g.home.score)}</span></span></span>
    <span class="status"><b>${esc(g.status)}</b><span>${g.period?`Q${g.period} • ${esc(g.clock)}`:new Date(g.date).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}</span></span></button>`).join(''):'<div class="card" style="padding:16px">No NFL games were returned for this date.</div>';
  $$('.game-card').forEach(b=>b.addEventListener('click',()=>selectGame(JSON.parse(b.dataset.game))));
}
async function selectGame(game){
  state.gameId=game.id;state.game=game;state.plays=[];renderScoreboard();renderFeed();page('game');
  const interval=Number(localStorage.getItem('pollInterval')||0.5),compare=localStorage.getItem('compareSources')==='true',preferred=localStorage.getItem('preferredSource')||'summary';
  try{await api(`/api/games/${state.gameId}/monitor`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({interval,compare,preferred_source:preferred})});connectEvents()}
  catch(e){setConnection('error','RECONNECTING');toast(`Could not start: ${e.message}`)}
}
function connectEvents(){
  state.eventSource?.close();const es=new EventSource(`/api/games/${state.gameId}/events`);state.eventSource=es;
  es.addEventListener('snapshot',e=>applySnapshot(JSON.parse(e.data)));es.addEventListener('update',e=>applyUpdate(JSON.parse(e.data)));
  es.onopen=()=>setConnection('live','LIVE');es.onerror=()=>setConnection('error','RECONNECTING');
}
function applySnapshot(data){state.game=data.game||state.game;state.plays=data.plays||[];state.lastCheck=data.last_check;state.lastNewPlay=data.last_new_play;state.resolution=data.resolution||{};state.fastcastStatus=data.fastcast_status||state.fastcastStatus;renderAll()}
function applyUpdate(data){
  const previousFastcast=state.fastcastStatus;state.lastCheck=data.last_check||state.lastCheck;state.lastNewPlay=data.last_new_play||state.lastNewPlay;state.game=data.game||state.game;state.resolution=data.resolution||state.resolution;state.fastcastStatus=data.fastcast_status||state.fastcastStatus;
  if(data.new)for(const p of data.new){const i=state.plays.findIndex(x=>x.play_id===p.play_id);i<0?state.plays.push(p):state.plays[i]=p}
  if(data.corrected)for(const p of data.corrected){const i=state.plays.findIndex(x=>x.play_id===p.play_id);i<0?state.plays.push(p):state.plays[i]=p}
  setConnection(data.status==='reconnecting'?'error':'live',data.status==='reconnecting'?'RECONNECTING':'LIVE');
  // Heartbeat ticks update only the small header. For a new play, paint the
  // headline first and rebuild the long feed after that frame is visible.
  renderScoreboard();
  if(previousFastcast!==state.fastcastStatus)renderLatest();
  if(data.type==='plays'){
    renderLatest();
    if(state.feedFrame)cancelAnimationFrame(state.feedFrame);
    state.feedFrame=requestAnimationFrame(()=>requestAnimationFrame(()=>{state.feedFrame=null;renderFeed()}));
  }
}
function setConnection(cls,label){const pill=$('#connectionPill');pill.className=`connection-pill ${cls}`;pill.querySelector('span').textContent=label;$('#liveDot').className=`dot ${cls}`;$('#liveState').textContent=label}
function renderAll(){renderScoreboard();renderLatest();renderFeed()}
function renderScoreboard(){
  if(!state.game)return;const g=state.game,a=g.away||{},h=g.home||{};
  $('#scoreboard').innerHTML=`<div class="team away"><img src="${esc(a.logo||'')}" alt=""><span class="abbr">${esc(a.abbreviation||'AWAY')}</span><strong>${esc(a.score||0)}</strong></div><div class="game-state"><b>${g.period?`Q${g.period} • ${esc(g.clock)}`:'—'}</b><span>${esc(g.status||'WAITING')}</span></div><div class="team home"><strong>${esc(h.score||0)}</strong><span class="abbr">${esc(h.abbreviation||'HOME')}</span><img src="${esc(h.logo||'')}" alt=""></div>`;
  const s=g.situation||{},bar=$('#situationBar');const text=[s.downDistanceText,s.possessionText,g.red_zone?'RED ZONE':null].filter(Boolean).join(' • ');bar.textContent=text;bar.classList.toggle('visible',!!text);
}
function renderLatest(){
  const latest=[...state.plays].sort((a,b)=>a.sequence-b.sequence).at(-1),el=$('#latestPlay');
  if(!latest)return;$('#sourceName').textContent=latest.source==='fastcast'?'FASTCAST PUSH':state.fastcastStatus==='active'?'FASTCAST ACTIVE':state.fastcastStatus==='connected'?'FASTCAST CONNECTED':latest.source==='core'?'CORE FALLBACK':`ESPN ${String(latest.source||'summary').toUpperCase()}`;el.classList.remove('empty');const down=latest.down?`${['','1ST','2ND','3RD','4TH'][latest.down]||latest.down} & ${latest.distance??'?'}`:'PLAY';
  let result=latest.scoring_play?'SCORING PLAY':latest.turnover?'TURNOVER':latest.penalty?'PENALTY':latest.yards>=10?'FIRST DOWN':'';
  el.innerHTML=`<div class="section-label">LATEST PLAY • Q${latest.quarter} ${esc(latest.game_clock)}</div><div class="latest-situation">${down}</div><div class="latest-location">${esc(latest.yard_line||latest.possession||'')}</div><div class="latest-description">${numberText(latest.description_enhanced)}</div>${result?`<div class="play-result">${result}</div>`:''}`;
}
function filteredPlays(){const q=$('#playSearch')?.value.trim().toLowerCase()||'';return state.plays.filter(p=>(state.filter==='all'||p.play_type===state.filter)&&( !q||p.description_enhanced.toLowerCase().includes(q)||p.participants?.some(x=>(x.full_name||x.name||'').toLowerCase().includes(q)||(x.jersey&&`#${x.jersey}`.includes(q)))))}
function renderFeed(){
  const el=$('#playFeed');if(!el)return;let plays=filteredPlays().sort((a,b)=>state.order==='newest'?b.sequence-a.sequence:a.sequence-b.sequence);
  if(!plays.length){el.innerHTML='<div class="muted" style="padding:18px 3px">No matching plays yet.</div>';return}
  const groups=[];for(const play of plays){const key=play.drive_id||'ungrouped';let group=groups.at(-1);if(!group||group.key!==key){group={key,team:play.drive_team,result:play.drive_result,plays:[]};groups.push(group)}group.plays.push(play)}
  el.innerHTML=groups.map(g=>`<section class="drive"><div class="drive-head">${esc(g.team||'GAME')} DRIVE</div>${g.plays.map(p=>`<article class="feed-play"><div class="meta"><span class="down">Q${p.quarter} • ${esc(p.game_clock)}${p.down?` • ${p.down}&${p.distance}`:''}</span><span>${esc(p.yard_line||'')}</span></div><p>${numberText(p.description_enhanced)}</p></article>`).join('')}${g.result?`<div class="drive-result">DRIVE RESULT: ${esc(g.result).toUpperCase()}</div>`:''}</section>`).join('');
}
function toast(text){const el=$('#markConfirmation');el.textContent=text;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2600)}

async function markNow(){if(!state.gameId)return toast('Select a game first');try{const m=await api(`/api/games/${state.gameId}/mark`,{method:'POST'});toast(`TV MARK SAVED • ${fmtTime(m.marked_at)}`)}catch(e){toast(e.message)}}
async function applySettings(){if(!state.gameId)return toast('Select a game first');const body={interval:Number($('#pollInterval').value),compare:$('#compareSources').checked,preferred_source:$('#preferredSource').value};Object.entries({pollInterval:body.interval,compareSources:body.compare,preferredSource:body.preferred_source}).forEach(([k,v])=>localStorage.setItem(k,v));await api(`/api/games/${state.gameId}/monitor`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});toast('LIVE SETTINGS APPLIED');connectEvents();loadLatency()}
function stat(label,value){return `<div class="stat"><label>${label}</label><strong>${value}</strong></div>`}
async function loadLatency(){
  if(!state.gameId){$('#statsGrid').innerHTML=stat('STATUS','SELECT GAME');return}if(state.csvUrl)URL.revokeObjectURL(state.csvUrl);state.csvUrl=URL.createObjectURL(new Blob([window.NFLLiveEngine.csvText()],{type:'text/csv;charset=utf-8'}));$('#csvExport').href=state.csvUrl;$('#csvExport').download=`NFL_Latency_Test_${new Date().toISOString().slice(0,10)}.csv`;
  try{const [data,health]=await Promise.all([api(`/api/games/${state.gameId}/latency`),api(`/api/health/sources?game_id=${state.gameId}`)]);const d=data.statistics.tv_delay_ms;
    $('#statsGrid').innerHTML=stat('MEDIAN TV DELAY',fmtMs(d.median))+stat('P90 TV DELAY',fmtMs(d.p90))+stat('FASTEST',fmtMs(d.min))+stat('SLOWEST',fmtMs(d.max))+stat('AVERAGE',fmtMs(d.average))+stat('PLAYS RECEIVED',data.statistics.plays_received)+stat('TV MARKS',d.count)+stat('P25 / P75',`${fmtMs(d.p25)} / ${fmtMs(d.p75)}`);
    const r=state.resolution||{};$('#resolutionMetric').textContent=r.players_detected?`Jersey resolution: ${r.numbers_resolved}/${r.players_detected} (${r.resolution_rate.toFixed(1)}%) • processing is recorded per play`:'Jersey resolution will appear after participant-bearing plays arrive.';
    $('#comparisonTable').innerHTML=data.comparison.length?data.comparison.map(x=>{const seen=[['FASTCAST',x.fastcast_first],['CORE',x.core_first],['SUMMARY',x.summary_first],['CDN',x.cdn_first]].filter(v=>v[1]).sort((a,b)=>new Date(a[1])-new Date(b[1]));let result=seen.length>1?`${seen[0][0]} first by ${((new Date(seen[1][1])-new Date(seen[0][1]))/1000).toFixed(3)} sec`:`${seen[0]?.[0]||'All'} first • others pending`;return `<tr><td>${esc(x.play_id)}</td><td>${fmtTime(x.fastcast_first)}</td><td>${fmtTime(x.core_first)}</td><td>${fmtTime(x.summary_first)}</td><td>${fmtTime(x.cdn_first)}</td><td>${result}</td></tr>`}).join(''):'<tr><td colspan="6">Waiting for the next new play in comparison mode.</td></tr>';
    $('#sourceHealth').innerHTML=health.sources.length?health.sources.map(s=>`<div class="health card"><div><b>${esc(s.endpoint).toUpperCase()}</b><small>Last success: ${fmtAgo(s.last_success)}</small></div><div><strong>${fmtMs(s.avg_ms)}</strong><small>${s.errors} errors / ${s.requests} events/checks</small></div></div>`).join(''):'<div class="muted">No requests recorded yet.</div>';
  }catch(e){$('#statsGrid').innerHTML=stat('ERROR',esc(e.message))}
}
async function loadRaw(kind){state.rawKind=kind;$$('[data-raw]').forEach(b=>b.classList.toggle('active',b.dataset.raw===kind));if(!state.gameId&&kind!=='scoreboard'){$('#rawViewer').textContent='Select and monitor a game first.';return}try{const data=await api(`/api/games/${state.gameId||'none'}/raw/${kind}`);state.rawText=JSON.stringify(data,null,2);filterRaw()}catch(e){$('#rawViewer').textContent=e.message}}
function filterRaw(){const q=$('#rawSearch').value.trim().toLowerCase();if(!q){$('#rawViewer').textContent=state.rawText;return}$('#rawViewer').textContent=state.rawText.split('\n').filter(line=>line.toLowerCase().includes(q)).join('\n')||'No matching lines.'}
async function loadHistory(){try{const data=await api('/api/history');$('#historyList').innerHTML=data.games.length?data.games.map(g=>`<article class="history-card card"><h3>${esc(g.away_abbr||'?')} at ${esc(g.home_abbr||'?')}</h3><p>${esc(g.date||'Unknown date')}</p><p>${g.play_count} plays captured this session • average request ${fmtMs(g.avg_request_ms)} • ${g.tv_marks} TV marks</p><button class="secondary compact" data-history="${esc(g.game_id)}">OPEN GAME</button></article>`).join(''):'<p class="muted">Games monitored in this browser session will appear here. Nothing is saved after the tab is closed.</p>';$$('[data-history]').forEach(b=>b.onclick=()=>selectGame({id:b.dataset.history,name:`NFL Game ${b.dataset.history}`,home:{},away:{}}))}catch(e){$('#historyList').textContent=e.message}}
async function loadAccess(){try{const d=await api('/api/access');for(const id of ['computerUrl','phoneUrl']){const link=$(`#${id}`);link.textContent=link.href=d.phone;link.target='_blank';link.rel='noopener'}$('#qrImage').src=`https://quickchart.io/qr?size=220&text=${encodeURIComponent(d.phone)}`}catch(e){toast(e.message)}}
function tick(){if(state.gameId){$('#lastCheck').textContent=`Last check: ${fmtAgo(state.lastCheck)}`;$('#lastPlayTime').textContent=`New play: ${fmtAgo(state.lastNewPlay)}`}}

$('#refreshGames').onclick=()=>loadGames();$('#loadDate').onclick=()=>loadGames($('#scoreboardDate').value.replaceAll('-',''));$('#markPlay').onclick=markNow;$('#applyMonitor').onclick=applySettings;
$('#orderToggle').textContent=state.order.toUpperCase()+' FIRST';$('#orderToggle').onclick=()=>{state.order=state.order==='newest'?'oldest':'newest';localStorage.setItem('playOrder',state.order);$('#orderToggle').textContent=state.order.toUpperCase()+' FIRST';renderFeed()};
$$('.filter').forEach(b=>b.onclick=()=>{$$('.filter').forEach(x=>x.classList.remove('active'));b.classList.add('active');state.filter=b.dataset.filter;renderFeed()});$('#playSearch').oninput=renderFeed;
$$('[data-raw]').forEach(b=>b.onclick=()=>loadRaw(b.dataset.raw));$('#rawSearch').oninput=filterRaw;$('#copyRaw').onclick=()=>navigator.clipboard.writeText(state.rawText).then(()=>toast('RAW JSON COPIED'));
$('#pollInterval').value=localStorage.getItem('pollInterval')||'0.5';$('#compareSources').checked=localStorage.getItem('compareSources')==='true';$('#preferredSource').value=localStorage.getItem('preferredSource')||'summary';
setInterval(tick,500);setInterval(()=>{if($('#labPage').classList.contains('active'))loadLatency()},5000);loadGames();
