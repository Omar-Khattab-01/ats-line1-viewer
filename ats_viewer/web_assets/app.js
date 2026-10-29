"use strict";

const $ = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="ats-token"]').content;
const state = {dataset:"", overview:null, snapshot:null, index:0, view:"overview", loading:false, playing:false, playTimer:null, followTimer:null, snapshotRequest:0, tableRequest:{}, pages:{record:0,event:0,file:0}, tableRows:{}, db:""};
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt = (value) => Number(value || 0).toLocaleString();
const clockText = (value) => value ? value.replace("T", " · ") : "Unknown capture time";
const shortTime = (value) => value ? value.split("T")[1]?.slice(0,8) || value : "—";
const basename = (value) => value.replace(/\\/g,"/").split("/").filter(Boolean).pop() || value;
const stationName = (platform) => state.overview?.station_names[platform?.split("-")[0]] || platform?.split("-")[0] || "Unknown";
const badge = (text, type="neutral") => `<span class="badge ${type}">${escapeHTML(text)}</span>`;
const empty = (message) => `<div class="empty">${escapeHTML(message)}</div>`;
const showError = (error) => { $("error").textContent = error.message || String(error); $("error").classList.remove("hidden"); };
const clearError = () => $("error").classList.add("hidden");
const safe = (fn) => (...args) => Promise.resolve().then(() => fn(...args)).catch(showError);
const debounce = (fn, delay=250) => { let timer; return (...args) => { clearTimeout(timer); timer=setTimeout(safe(() => fn(...args)),delay); }; };
const selectedFiles = () => state.overview?.snapshots.filter(s => !s.duplicate_of) || [];
const downloadURL = (path, values={}) => `${path}?${new URLSearchParams({dataset:state.dataset,token,...values})}`;

async function api(path, values={}, body=null) {
  const options = {headers:{"X-ATS-Token":token}};
  if (body !== null) { options.method="POST"; options.headers["Content-Type"]="application/json"; options.body=JSON.stringify(body); }
  const response = await fetch(path + (Object.keys(values).length ? `?${new URLSearchParams(values)}` : ""), options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function setView(view) {
  state.view=view;
  document.querySelectorAll(".nav").forEach(b => {b.classList.toggle("active",b.dataset.view===view); b.setAttribute("aria-current",b.dataset.view===view ? "page" : "false");});
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("hidden",v.id!==`view-${view}`));
  if (!state.overview) return;
  if (view==="overview") renderOverview();
  if (view==="board") renderBoard();
  if (view==="trains") {renderTrains(); safe(loadHistory)();}
  if (view==="health") renderHealth();
  if (view==="records") safe(() => loadTable("record"))();
  if (view==="events") safe(() => loadTable("event"))();
}

function stopPlayback() {
  state.playing=false; clearTimeout(state.playTimer); $("play").textContent="▶"; $("play").setAttribute("aria-label","Play snapshots");
}

async function chooseSnapshot(index) {
  const files=selectedFiles();
  if (!files.length) return;
  const request=++state.snapshotRequest;
  state.index=Math.max(0,Math.min(files.length-1,index));
  $("timeline").value=state.index;
  const snapshot=await api("/api/snapshot",{dataset:state.dataset,id:files[state.index].id,clock:$("clock").value || 0});
  if (request!==state.snapshotRequest) return;
  state.snapshot=snapshot;
  $("snapshot-counter").textContent=`${fmt(state.index+1)} / ${fmt(files.length)}`;
  $("capture").textContent=clockText(snapshot.capture);
  $("feed-clock").textContent=`Filename clock · XML reference ${shortTime(snapshot.feed_reference)} · offset ${Number($("clock").value)>=0?"+":""}${$("clock").value} min (configured)`;
  $("snapshot-status").textContent=snapshot.status==="valid" ? `${snapshot.predictions.length} predictions · ${snapshot.events.length} reported events` : `${snapshot.status.toUpperCase()} · ${snapshot.error}`;
  $("prev").disabled=state.index===0; $("next").disabled=state.index===files.length-1;
  $("view-xml").disabled=snapshot.size===0;
  if (state.view==="overview") renderOverview();
  if (state.view==="board") renderBoard();
  if (state.view==="trains") renderTrains();
  if (state.view==="health") renderHealth();
  if (state.view==="records" && $("current-only").checked) {state.pages.record=0; await loadTable("record");}
}

async function playNext() {
  if (!state.playing) return;
  const files=selectedFiles();
  if (state.index>=files.length-1) return stopPlayback();
  const a=wallMillis(files[state.index].capture), b=wallMillis(files[state.index+1].capture);
  const delay=Number.isFinite(a)&&Number.isFinite(b) ? Math.max(200,(b-a)/Number($("speed").value)) : 1000;
  state.playTimer=setTimeout(safe(async () => {if(!state.playing)return; await chooseSnapshot(state.index+1); await playNext();}),delay);
}

async function loadCollection(follow=false) {
  if (state.loading) return;
  const path=$("source-path").value.trim();
  if (!path) throw new Error("Enter a folder or ZIP path first.");
  if (!$("clock").checkValidity()) throw new Error("Choose a clock difference between -1440 and 1440 minutes.");
  clearError(); stopPlayback(); state.loading=true;
  $("load").disabled=true; $("refresh").disabled=true; $("progress").classList.remove("hidden");
  const prior=state.snapshot?.name;
  try {
    await api("/api/load",{}, {path});
    let job;
    do {
      await new Promise(resolve=>setTimeout(resolve,350));
      job=await api("/api/job");
      $("progress-text").textContent=`${job.message || "Reading files"} · ${fmt(job.scanned)} read · ${fmt(job.changed)} updated`;
    } while(job.status==="running");
    if (job.status!=="complete") throw new Error(job.error || "Import failed");
    const changedDataset=state.dataset!==job.dataset;
    state.dataset=job.dataset;
    const overview=await api("/api/overview",{dataset:state.dataset});
    state.overview=overview;
    if (changedDataset) resetFilters();
    localStorage.setItem("ats-path",path); localStorage.setItem("ats-clock",$("clock").value);
    setupWorkspace();
    const files=selectedFiles();
    const priorIndex=files.findIndex(s=>s.name===prior);
    await chooseSnapshot(follow ? files.length-1 : priorIndex>=0 ? priorIndex : 0);
    $("source-panel").open=false;
    setView(state.view);
    const session=await api("/api/session"); fillRecent(session.datasets);
  } finally {
    state.loading=false; $("load").disabled=false; $("refresh").disabled=false; $("progress").classList.add("hidden");
  }
}

function optionHTML(values, first) {
  return (first ? `<option value="">${escapeHTML(first)}</option>` : "") + values.map(v=>`<option value="${escapeHTML(v.value ?? v)}">${escapeHTML(v.label ?? v)}</option>`).join("");
}

function fillSelect(id, values, first=null) {
  const old=$(id).value; $(id).innerHTML=optionHTML(values,first);
  if (Array.from($(id).options).some(o=>o.value===old)) $(id).value=old;
}

function resetFilters() {
  ["record-search","event-search","board-search","file-search","record-from","record-to"].forEach(id=>$(id).value="");
  ["record-train","record-platform","record-flag","event-train","event-platform","event-code","board-direction","file-filter"].forEach(id=>$(id).selectedIndex=0);
  $("current-only").checked=false; state.pages={record:0,event:0,file:0};
}

function setupWorkspace() {
  const o=state.overview,s=o.stats;
  $("welcome").classList.add("hidden"); $("workspace").classList.remove("hidden");
  $("collection-name").textContent=basename(o.collection.path);
  $("collection-summary").textContent=`${fmt(s.files)} source files · ${s.first?.slice(0,10) || "no capture date"}`;
  $("source-caption").textContent=o.collection.path;
  $("source-caption").title=o.collection.path;
  $("issue-count").textContent=s.invalid || "";
  $("metrics").innerHTML=[
    ["Source snapshots",fmt(s.files),`${fmt(s.valid)} readable · ${fmt(s.invalid)} empty / invalid`,"▱"],
    ["Prediction records",fmt(s.predictions),`${fmt(s.predicted_platforms)} platforms with predictions`,"≋"],
    ["Distinct trains",fmt(s.trains),"Across the complete collection","⇄"],
    ["Capture interval",s.median_interval!==null ? `${s.median_interval}s` : "—","Median between readable captures","◷"]
  ].map(([label,value,note,icon])=>`<article class="metric"><div class="metric-top"><span>${label}</span><span>${icon}</span></div><strong>${value}</strong><small>${note}</small></article>`).join("");
  const files=selectedFiles();
  $("timeline").max=Math.max(0,files.length-1);
  $("range-start").textContent=clockText(s.first); $("range-end").textContent=clockText(s.last);
  const platforms=o.platforms.map(p=>({value:p.platform,label:`${p.platform} · ${stationName(p.platform)}`}));
  const trains=o.trains.map(t=>({value:t.train_id,label:`Train ${t.train_id || "(missing ID)"}`}));
  ["record-train","event-train"].forEach(id=>fillSelect(id,trains,"All trains"));
  ["record-platform","event-platform"].forEach(id=>fillSelect(id,platforms,"All platforms"));
  fillSelect("history-train",trains); fillSelect("history-platform",platforms);
  fillSelect("event-code",o.event_codes.map(c=>({value:c.code,label:`${c.code} · ${fmt(c.count)} records` })),"All codes");
  $("database-export").href=downloadURL("/api/database");
  $("database-location").textContent=`Workspace: ${state.db}. Contains raw XML and parsed records for all imported collections. Removing source files removes them from their collection on the next rescan. Duplicate copies are excluded from prediction and event totals. Reloading a saved collection does not rescan until you choose Rescan folder.`;
}

function groupedTrains() {
  const groups=new Map();
  for (const p of state.snapshot?.predictions || []) {
    if(!groups.has(p.train_id)) groups.set(p.train_id,[]);
    groups.get(p.train_id).push(p);
  }
  return Array.from(groups.entries()).sort((a,b)=>a[0]?.localeCompare(b[0],undefined,{numeric:true}));
}

function trainSummary(predictions) {
  const unique=key=>Array.from(new Set(predictions.map(p=>p[key]).filter(v=>v!==null && v!=="")));
  return {destinations:unique("destination"),speeds:unique("speed"),directions:unique("direction"),next:unique("next_platform"),cars:unique("cars")};
}

function renderOverview() {
  if(!state.snapshot) return;
  const snap=state.snapshot,o=state.overview;
  $("line-map").innerHTML=Object.entries(o.station_names).map(([code,name])=>{
    const platforms=snap.platforms.filter(p=>p.platform.startsWith(`${code}-`));
    const predictions=snap.predictions.filter(p=>p.platform.startsWith(`${code}-`));
    const flagged=platforms.some(p=>p.closed==="true"||p.held==="true");
    return `<div class="station ${predictions.length?"available":""} ${flagged?"flagged":""}"><button data-station="${escapeHTML(code)}" aria-label="View ${escapeHTML(name)} predictions"></button><strong>${escapeHTML(name)}</strong><span class="station-code">${code}</span><span class="station-count">${predictions.length?`${predictions.length} calls`:"—"}</span></div>`;
  }).join("");
  $("line-map").querySelectorAll("[data-station]").forEach(b=>b.onclick=()=>{$("board-search").value=b.dataset.station;setView("board");});
  const trains=groupedTrains();
  $("overview-trains").innerHTML=trains.length ? trains.map(([id,p])=>{
    const summary=trainSummary(p);
    return `<div class="train-row"><span class="train-token">${escapeHTML(id || "?")}</span><div class="train-info"><strong>${escapeHTML(summary.destinations.join(" / ") || "Destination not supplied")}</strong><span>${p.length} platform predictions · dir ${escapeHTML(summary.directions.join(" / ") || "—")}</span></div><button class="link" data-train="${escapeHTML(id)}">Inspect →</button></div>`;
  }).join("") : empty(snap.status==="valid" ? "No train predictions reported in this snapshot." : "This snapshot has no readable prediction data. Open File health for details.");
  $("overview-trains").querySelectorAll("[data-train]").forEach(b=>b.onclick=()=>{$("history-train").value=b.dataset.train;setView("trains");});
  const flagged=snap.platforms.filter(p=>p.closed==="true"||p.held==="true");
  const notes=[
    ["Clock alignment needs confirmation",`Countdowns use XML minus filename = ${$("clock").value} minutes. The export does not declare a timezone.`,"◷"],
    [o.stats.invalid ? `${o.stats.invalid} unreadable snapshots` : "Every source file is readable",o.stats.invalid ? "Empty or invalid files stay in the timeline so capture gaps remain visible." : "Readable XML does not establish operational correctness.","◇"],
    [flagged.length ? `${flagged.length} flagged platforms in this snapshot` : "No held or closed flags in this snapshot",flagged.length ? flagged.map(p=>`${p.platform}: ${p.closed==="true"?"closed ":""}${p.held==="true"?"held":""}`).join(" · ") : "Platform flags are taken directly from the source XML.","▤"],
    [`${fmt(o.stats.events)} reported event records`,"Event codes are shown as received. Repeated events across different snapshots are retained.","≋"]
  ];
  $("feed-notes").innerHTML=notes.map(([title,text,icon])=>`<div class="note"><span class="note-icon">${icon}</span><div><strong>${escapeHTML(title)}</strong><p>${escapeHTML(text)}</p></div></div>`).join("");
}

function eta(seconds) {
  if(seconds===null) return `<span class="eta">—<small>unaligned clock</small></span>`;
  const negative=seconds<0, abs=Math.abs(seconds), value=abs<60 ? `${Math.round(abs)}s` : `${Math.floor(abs/60)}:${String(Math.floor(abs%60)).padStart(2,"0")}`;
  return `<span class="eta ${negative?"warn-text":""}">${negative?"−":""}${value}<small>${negative?"before capture":"to arrival"}</small></span>`;
}

function renderBoard() {
  if(!state.snapshot) return;
  const snap=state.snapshot,q=$("board-search").value.toLowerCase().trim(),dir=$("board-direction").value;
  const platforms=snap.platforms.filter(p=>{
    const text=`${p.platform} ${stationName(p.platform)}`.toLowerCase();
    return (!q||text.includes(q)) && (!dir||p.platform.split("-")[1]?.startsWith(dir)) && ($("show-empty").checked || p.closed==="true" || p.held==="true" || snap.predictions.some(r=>r.platform===p.platform));
  });
  $("board").innerHTML=platforms.length ? platforms.map(p=>{
    const predictions=snap.predictions.filter(r=>r.platform===p.platform);
    return `<article class="panel board-card"><header><h3>${escapeHTML(stationName(p.platform))}</h3><code>${escapeHTML(p.platform)}</code></header><div class="platform-flags">${p.closed==="true"?badge("CLOSED","bad"):""}${p.held==="true"?badge("HELD","warn"):""}${p.closed!=="true"&&p.held!=="true"?badge(`${p.platform.split("-")[1] || "?"} PLATFORM`):""}</div>${predictions.length?predictions.map(r=>`<div class="arrival"><button class="train-token" data-board-row="${r.row_id}" aria-label="Inspect train ${escapeHTML(r.train_id)} prediction at ${escapeHTML(p.platform)}">${escapeHTML(r.train_id||"?")}</button><div><strong>${escapeHTML(r.destination || "Destination not supplied")}</strong><small>arr ${shortTime(r.arr)} · dep ${shortTime(r.dep)}</small><small>${r.stop==="false"?"PASSING · ":""}${r.service==="false"?"serv=false · ":""}dir ${escapeHTML(r.direction||"—")} · next ${escapeHTML(r.next_platform||"—")}</small></div>${eta(r.eta_seconds)}</div>`).join(""):empty("No predictions reported")}</article>`;
  }).join("") : empty(snap.status!=="valid" ? "This snapshot is empty or invalid. Choose another capture to view platform data." : "No platforms match. Try another search or include platforms without predictions.");
  $("board").querySelectorAll("[data-board-row]").forEach(b=>b.onclick=()=>rowDetail(snap.predictions.find(r=>String(r.row_id)===b.dataset.boardRow),snap));
}

function renderTrains() {
  const current=new Map(groupedTrains());
  $("train-cards").innerHTML=state.overview.trains.map(train=>{
    const p=current.get(train.train_id)||[],s=trainSummary(p),selected=$("history-train").value===train.train_id;
    return `<button class="panel train-card ${selected?"selected":""}" data-pick-train="${escapeHTML(train.train_id)}"><span class="train-token">${escapeHTML(train.train_id||"?")}</span><h3>Train ${escapeHTML(train.train_id)}</h3><p>${p.length ? `${p.length} predictions in selected snapshot` : "Absent from selected snapshot"}<br>${escapeHTML(s.destinations.join(" / ")||"No destination in this snapshot")}<br>${fmt(train.snapshots)} snapshots across collection<br>Speed (raw): ${escapeHTML(s.speeds.join(" / ")||"—")} · Cars (raw): ${escapeHTML(s.cars.join(" / ")||"—")}</p></button>`;
  }).join("") || empty("No train prediction records are available in this collection.");
  $("train-cards").querySelectorAll("[data-pick-train]").forEach(b=>b.onclick=safe(async()=>{$("history-train").value=b.dataset.pickTrain;renderTrains();await loadHistory();}));
}

function wallMillis(value) {
  if(!value)return NaN;
  return Date.parse(value + (/[zZ]$|[+-]\d\d:\d\d$/.test(value)?"":"Z"));
}

async function loadHistory() {
  const train=$("history-train").value,platform=$("history-platform").value;
  if(!train) {$("history-chart").innerHTML=empty("No train history is available.");$("history-table").innerHTML="";return;}
  const key=`${state.dataset}:${train}:${platform}`; state.historyRequest=key;
  const filters={dataset:state.dataset,kind:"predictions",train,platform,limit:1000};
  const data=await api("/api/rows",filters);
  if(state.historyRequest!==key)return;
  $("history-title").textContent=`Train ${train} · ${platform} prediction history`;
  $("history-export").href=downloadURL("/api/export",{kind:"predictions",train,platform});
  const points=data.rows.map(r=>({...r,x:wallMillis(r.capture),y:wallMillis(r.arr)})).filter(r=>Number.isFinite(r.x)&&Number.isFinite(r.y));
  if(points.length<2) $("history-chart").innerHTML=empty(points.length ? "Only one timestamped prediction matches. A history chart needs two." : "No timestamped predictions for this train and platform.");
  else {
    const W=900,H=240,L=90,R=25,T=15,B=35,xmin=Math.min(...points.map(p=>p.x)),xmax=Math.max(...points.map(p=>p.x)),ymin=Math.min(...points.map(p=>p.y)),ymax=Math.max(...points.map(p=>p.y));
    const x=v=>L+(v-xmin)/(xmax-xmin||1)*(W-L-R), y=v=>H-B-(v-ymin)/(ymax-ymin||1)*(H-T-B);
    let grid="";
    for(let i=0;i<5;i++) {const v=ymin+(ymax-ymin)*i/4,py=y(v);grid+=`<line class="chart-grid" x1="${L}" y1="${py}" x2="${W-R}" y2="${py}"/><text class="chart-label" x="${L-10}" y="${py+3}" text-anchor="end">${new Date(v).toISOString().slice(11,19)}</text>`;}
    for(let i=0;i<4;i++) {const v=xmin+(xmax-xmin)*i/3,px=x(v);grid+=`<text class="chart-label" x="${px}" y="${H-12}" text-anchor="middle">${new Date(v).toISOString().slice(11,19)}</text>`;}
    // Points only: no connecting line across missing snapshots or changing runs.
    const marks=points.map(p=>`<circle class="chart-point" cx="${x(p.x)}" cy="${y(p.y)}" r="2.5"><title>Capture ${escapeHTML(p.capture)}; predicted arrival ${escapeHTML(p.arr)}</title></circle>`).join("");
    $("history-chart").innerHTML=`<p class="table-meta">Y: predicted arrival (XML clock) · X: capture (filename clock) · ${fmt(points.length)} plotted / ${fmt(data.total)} matching records</p><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Predicted arrival times for train ${escapeHTML(train)} at ${escapeHTML(platform)} across captured snapshots">${grid}${marks}</svg>`;
  }
  const sample=data.rows.slice(-10).reverse();
  $("history-table").innerHTML=`<p class="table-meta">Last ${sample.length} of the first ${Math.min(1000,data.total)} matching records · export CSV for all ${fmt(data.total)}</p>` + makeTable(["Capture","Arrival (XML)","Departure (XML)","Destination","Dir","Speed (raw)"],sample.map(r=>[clockText(r.capture),r.arr||"—",r.dep||"—",r.destination||"—",r.direction||"—",r.speed??"—"]));
}

function makeTable(headers, records, attrs=[]) {
  if(!records.length)return empty("No records match these filters.");
  return `<table><thead><tr>${headers.map(h=>`<th>${escapeHTML(h)}</th>`).join("")}</tr></thead><tbody>${records.map((cells,i)=>`<tr ${attrs[i]||""}>${cells.map(c=>`<td>${escapeHTML(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function rowFilters(prefix) {
  const isRecord=prefix==="record";
  const values={kind:isRecord?"predictions":"events",train:$(`${prefix}-train`).value,platform:$(`${prefix}-platform`).value,q:$(`${prefix}-search`).value};
  if(isRecord) Object.assign(values,{flag:$("record-flag").value,from:$("record-from").value,to:$("record-to").value,snapshot:$("current-only").checked?state.snapshot?.id||"":""});
  else values.code=$("event-code").value;
  return values;
}

function pagination(prefix, total, perPage, rerender) {
  const index=state.pages[prefix],start=index*perPage;
  $(`${prefix}-pagination`).innerHTML=`<span>${total?`${fmt(start+1)}–${fmt(Math.min(start+perPage,total))}`:"0"} of ${fmt(total)} ${prefix==="file"?"files":"records"}${prefix!=="file"?" · click a row for source details":""}</span><button data-page="prev" ${index===0?"disabled":""}>Previous</button><button data-page="next" ${start+perPage>=total?"disabled":""}>Next</button>`;
  $(`${prefix}-pagination`).querySelectorAll("[data-page]").forEach(b=>b.onclick=safe(()=>{state.pages[prefix]+=b.dataset.page==="next"?1:-1;return rerender();}));
}

async function loadTable(prefix) {
  const filters=rowFilters(prefix),request=(state.tableRequest[prefix]||0)+1;
  state.tableRequest[prefix]=request;
  $(`${prefix}-export`).href=downloadURL("/api/export",filters);
  const result=await api("/api/rows",{dataset:state.dataset,...filters,limit:100,offset:state.pages[prefix]*100});
  if(state.tableRequest[prefix]!==request)return;
  state.tableRows[prefix]=result.rows;
  let headers,records;
  if(prefix==="record") {
    headers=["Capture (filename)","Platform","Train","Arrival (XML)","Departure (XML)","Destination","Next","Dir","Stop","Serv","Speed (raw)","Cars (raw)"];
    records=result.rows.map(r=>[clockText(r.capture),r.platform,r.train_id,r.arr||"—",r.dep||"—",r.destination||"—",r.next_platform||"—",r.direction||"—",r.stop??"—",r.service??"—",r.speed??"—",r.cars??"—"]);
  } else {
    headers=["Event time (XML)","Code","Platform","Train","Vehicle IDs","Captured (filename)","Source file"];
    records=result.rows.map(r=>[r.time||"—",r.code||"—",r.platform||"—",r.train_id||"—",r.vehicles.join(" / "),clockText(r.capture),basename(r.source)]);
  }
  $(`${prefix}-table`).innerHTML=makeTable(headers,records,result.rows.map((r,i)=>`data-detail="${i}" tabindex="0" role="button" aria-label="Open ${prefix} source record ${i+1}"`));
  $(`${prefix}-table`).querySelectorAll("[data-detail]").forEach(tr=>{
    const open=()=>rowDetail(result.rows[Number(tr.dataset.detail)],null);
    tr.onclick=open;tr.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();open();}};
  });
  pagination(prefix,result.total,100,()=>loadTable(prefix));
}

function renderHealth() {
  const o=state.overview,s=o.stats;
  $("health-summary").innerHTML=[[s.invalid,"Empty / invalid files"],[s.duplicates,"Duplicate copies excluded"],[o.gaps.length,`Gaps over ${s.gap_threshold}s`]].map(([n,label])=>`<article class="panel health-card"><strong>${fmt(n)}</strong><span>${escapeHTML(label)}</span></article>`).join("");
  $("coverage").innerHTML=o.snapshots.map(f=>`<button class="${f.duplicate_of?"duplicate":f.status} ${f.id===state.snapshot?.id?"current":""}" data-file="${f.id}" title="${escapeHTML(`${f.name} · ${f.duplicate_of?"duplicate":f.status}`)}" aria-label="${escapeHTML(`${f.name}, ${f.duplicate_of?"duplicate":f.status}`)}"></button>`).join("");
  $("coverage").querySelectorAll("[data-file]").forEach(b=>b.onclick=safe(()=>openSnapshot(Number(b.dataset.file))));
  $("gaps").innerHTML=o.gaps.length ? o.gaps.map(g=>`<p class="gap-note warn-text">${escapeHTML(clockText(g.from))} → ${escapeHTML(clockText(g.to))}: ${g.seconds}s between readable captures</p>`).join("") : `<p class="gap-note muted">No readable-capture intervals exceed ${s.gap_threshold}s (greater of 60 seconds or 3× the median). Empty files remain visible above.</p>`;
  const q=$("file-search").value.toLowerCase(),filter=$("file-filter").value;
  const files=o.snapshots.filter(f=>(!q||`${f.name} ${f.status} ${f.error||""} ${f.warnings.join(" ")}`.toLowerCase().includes(q))&&(filter!=="issues"||f.status!=="valid"||f.warnings.length)&&(filter!=="duplicate"||f.duplicate_of));
  if(state.pages.file*100>=files.length)state.pages.file=0;
  const sample=files.slice(state.pages.file*100,(state.pages.file+1)*100);
  $("file-table").innerHTML=makeTable(["Captured (filename)","Source file","Status","Bytes","Notes"],sample.map(f=>[clockText(f.capture),f.name,f.duplicate_of?`duplicate of #${f.duplicate_of}`:f.status,fmt(f.size),f.error||f.warnings.join(" · ")||"—"]),sample.map(f=>`data-snapshot="${f.id}" tabindex="0" role="button" aria-label="Inspect ${escapeHTML(f.name)}"`));
  $("file-table").querySelectorAll("[data-snapshot]").forEach(tr=>{const open=()=>fileDetail(o.snapshots.find(f=>f.id===Number(tr.dataset.snapshot)));tr.onclick=open;tr.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();open();}};});
  pagination("file",files.length,100,renderHealth);
}

async function openSnapshot(sid) {
  const file=state.overview.snapshots.find(s=>s.id===sid);
  const effective=file?.duplicate_of || sid,index=selectedFiles().findIndex(f=>f.id===effective);
  if(index<0) return;
  stopPlayback(); await chooseSnapshot(index);
}

function modal(title, html) {
  $("detail-title").textContent=title; $("detail-content").innerHTML=html;
  if(!$("detail").open)$("detail").showModal();
}

function rowDetail(row, snapshot) {
  if(!row)return;
  const sid=row.snapshot || snapshot?.id;
  modal(`Train ${row.train_id || "?"} · ${row.platform || "unknown platform"}`,`<p>Source: ${escapeHTML(row.source||snapshot?.name||"Selected snapshot")}<br>Capture (filename): ${escapeHTML(row.capture||snapshot?.capture||"unknown")}</p><div class="dialog-actions"><button class="button" id="modal-source">View original XML</button><button class="button" id="modal-snapshot">Go to snapshot</button></div><p>Fields below are preserved as reported. Missing fields remain missing. Event codes, dir, cars and speed do not receive an inferred meaning or unit.</p><pre>${escapeHTML(JSON.stringify(row.raw,null,2))}</pre>`);
  $("modal-source").onclick=safe(()=>viewXML(sid));
  $("modal-snapshot").onclick=safe(async()=>{$("detail").close();await openSnapshot(sid);setView("overview");});
}

function fileDetail(file) {
  modal(basename(file.name),`<p>${escapeHTML(file.name)}</p><div class="dialog-actions">${badge(file.status,file.status==="valid"?"good":"bad")}<button class="button" id="modal-snapshot">Go to snapshot</button><button class="button" id="modal-source" ${file.size===0?"disabled":""}>View XML</button><a class="button" href="${escapeHTML(downloadURL("/api/raw",{id:file.id,download:1}))}" download>Download original</a></div><pre>${escapeHTML(JSON.stringify(file,null,2))}</pre>`);
  $("modal-source").onclick=safe(()=>viewXML(file.id));
  $("modal-snapshot").onclick=safe(async()=>{$("detail").close();await openSnapshot(file.id);setView("overview");});
}

async function viewXML(sid) {
  const response=await fetch(`/api/raw?${new URLSearchParams({dataset:state.dataset,id:sid})}`,{headers:{"X-ATS-Token":token}});
  if(!response.ok)throw new Error("Source XML could not be opened");
  const raw=await response.text();
  const file=state.overview.snapshots.find(s=>s.id===sid);
  // Readable whitespace is added only to the preview. Download preserves bytes.
  const preview=raw.replace(/></g,">\n<");
  modal("Original XML · source preview",`<p>${escapeHTML(file?.name||"Snapshot")} · Preview line breaks added for readability. The original download is byte-for-byte preserved.</p><a class="button" href="${escapeHTML(downloadURL("/api/raw",{id:sid,download:1}))}" download>Download original XML ↓</a><pre>${escapeHTML(preview)}</pre>`);
}

function fillRecent(datasets) {
  $("recent-wrap").classList.toggle("hidden",!datasets.length);
  $("recent").innerHTML=optionHTML(datasets.map(d=>({value:d.id,label:basename(d.path)})),"Choose a saved collection");
  state.recent=datasets;
}

document.querySelectorAll("[data-view]").forEach(b=>b.onclick=()=>setView(b.dataset.view));
document.querySelectorAll("[data-go]").forEach(b=>b.onclick=()=>setView(b.dataset.go));
$("load-form").onsubmit=e=>{e.preventDefault();safe(()=>loadCollection())();};
$("browse").onclick=safe(async()=>{const result=await api("/api/pick",{},{kind:"folder"});if(result.path)$("source-path").value=result.path;});
$("browse-zip").onclick=safe(async()=>{const result=await api("/api/pick",{},{kind:"zip"});if(result.path)$("source-path").value=result.path;});
$("refresh").onclick=safe(()=>loadCollection($("follow").checked));
$("clock").onchange=safe(async()=>{
  if(!$("clock").checkValidity())throw new Error("Clock difference must be a whole number between -1440 and 1440 minutes.");
  localStorage.setItem("ats-clock",$("clock").value);if(state.dataset)await chooseSnapshot(state.index);
});
$("recent").onchange=safe(async()=>{
  const collection=state.recent.find(d=>d.id===$("recent").value);if(!collection)return;
  stopPlayback(); state.dataset=collection.id; state.overview=await api("/api/overview",{dataset:state.dataset});
  $("source-path").value=collection.path;resetFilters();setupWorkspace();await chooseSnapshot(0);$("source-panel").open=false;setView(state.view);
});
$("timeline").oninput=debounce(async()=>{stopPlayback();await chooseSnapshot(Number($("timeline").value));},45);
$("prev").onclick=safe(async()=>{stopPlayback();await chooseSnapshot(state.index-1);});
$("next").onclick=safe(async()=>{stopPlayback();await chooseSnapshot(state.index+1);});
$("play").onclick=safe(async()=>{
  if(state.playing)return stopPlayback();
  if(state.index>=selectedFiles().length-1)await chooseSnapshot(0);
  state.playing=true;$("play").textContent="Ⅱ";$("play").setAttribute("aria-label","Pause playback");await playNext();
});
$("speed").onchange=safe(async()=>{if(state.playing){clearTimeout(state.playTimer);await playNext();}});
$("follow").onchange=()=>{
  clearInterval(state.followTimer);
  if($("follow").checked)state.followTimer=setInterval(safe(async()=>{if(state.dataset&&!state.loading){try{await loadCollection(true);}catch(error){$("follow").checked=false;clearInterval(state.followTimer);throw error;}}}),10000);
};
$("view-xml").onclick=safe(()=>viewXML(state.snapshot.id));
$("board-search").oninput=debounce(renderBoard,120);$("board-direction").onchange=renderBoard;$("show-empty").onchange=renderBoard;
$("history-train").onchange=safe(async()=>{renderTrains();await loadHistory();});$("history-platform").onchange=safe(loadHistory);
for(const prefix of ["record","event"]) {
  const changed=()=>{state.pages[prefix]=0;return loadTable(prefix);};
  $(`${prefix}-search`).oninput=debounce(changed);
  for(const suffix of ["train","platform",...(prefix==="record"?["flag","from","to"]:["code"])])$(`${prefix}-${suffix}`).onchange=safe(changed);
}
$("current-only").onchange=safe(()=>{state.pages.record=0;return loadTable("record");});
$("clear-filters").onclick=safe(()=>{["record-search","record-from","record-to","record-train","record-platform","record-flag"].forEach(id=>$(id).value="");$("current-only").checked=false;state.pages.record=0;return loadTable("record");});
$("file-search").oninput=debounce(()=>{state.pages.file=0;renderHealth();});$("file-filter").onchange=()=>{state.pages.file=0;renderHealth();};
$("close-detail").onclick=()=>$("detail").close();
$("detail").onclick=e=>{if(e.target===$("detail")){const r=$("detail").getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$("detail").close();}};
$("help").onclick=()=>modal("Reading the ATS feed",`<p>This viewer reads <code>PredictionEventAll</code> XML exports, including their platform predictions, platform flags, and event lists. It runs on this computer with no external services.</p><ul><li><b>Capture time</b> comes from <code>tp_YYYYMMDDHHMMSS.xml</code>. It is not an XML generation timestamp. Files without that name remain browsable but cannot supply a countdown.</li><li><b>Clock alignment:</b> XML values have no timezone in the sample. +240 minutes is an adjustable assumption suggested by the four-hour difference. There is no automatic timezone conversion. Countdown = XML arrival − (filename capture + configured offset). For clock changes, separate the capture periods. Mixed explicit/implicit timezone values are not subtracted.</li><li><b>Predictions:</b> a train may appear at many platforms in the same snapshot. These are predicted calls, not separate trains, measured delay, or confirmed arrivals. No train location is inferred.</li><li><b>Codes:</b> platform E/W suffixes and dir codes such as GD0, GD1 and No Motion are shown as received. No mapping from GD codes to direction is assumed. Speed and cars retain raw values; no units or consist interpretation are asserted.</li><li><b>Events:</b> numeric IDs stay numeric without a supplied event dictionary. Repeated event records in different captures are retained. All repeated thalesVehicleId fields are preserved.</li><li><b>Duplicates:</b> byte-identical XML with the same capture timestamp is counted once; a later capture of identical content is still a separate observation.</li><li><b>Collection:</b> folders are scanned recursively for XML and ZIPs. Sources are read only. Rescan updates changed files and removes records for removed sources. Follow new files rescans every 10 seconds; it does not connect to ATS directly.</li><li><b>Workspace:</b> raw bytes and parsed records from imported collections are stored in one local SQLite file. Save workspace downloads a consistent copy. To reopen a downloaded workspace, run <code>python -m ats_viewer --database /path/to/ats-workspace.sqlite --open</code> and choose a saved collection.</li><li><b>Platform coverage:</b> the schematic labels the 13 familiar Line 1 core stations as a display aid. All other ATS platform codes remain available unchanged in Station board and Raw records. Unknown platforms are never assigned an invented name.</li></ul>`);

safe(async()=>{
  const session=await api("/api/session");state.db=session.database;fillRecent(session.datasets);
  $("source-path").value=session.initial_path||localStorage.getItem("ats-path")||"";
  const savedClock=localStorage.getItem("ats-clock");if(savedClock!==null&&Number.isFinite(Number(savedClock)))$("clock").value=savedClock;
  if(session.initial_path)await loadCollection();
  else if(session.datasets.length) {
    const latest=session.datasets[0];state.dataset=latest.id;state.overview=await api("/api/overview",{dataset:state.dataset});
    $("source-path").value=latest.path;setupWorkspace();await chooseSnapshot(0);$("source-panel").open=false;
  }
})();
