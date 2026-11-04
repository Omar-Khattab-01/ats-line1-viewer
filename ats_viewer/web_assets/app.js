"use strict";

const $ = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="ats-token"]').content;
const state = {dataset:"", overview:null, snapshot:null, index:0, view:"overview", loading:false, playing:false, playTimer:null, followTimer:null, snapshotRequest:0, tableRequest:{}, pages:{record:0,event:0,file:0}, tableRows:{}, analyticsRequest:0, analyticsCounts:null, db:""};
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt = (value) => Number(value || 0).toLocaleString();
const clockText = (value) => value ? value.replace("T", " · ") : "Unknown capture time";
const shortTime = (value) => value ? value.split("T")[1]?.slice(0,8) || value : "—";
const basename = (value) => value.replace(/\\/g,"/").split("/").filter(Boolean).pop() || value;
const stationName = (platform) => state.overview?.station_names[platform?.split("-")[0]] || platform?.split("-")[0] || "Unknown";
const trainLabel = (id, row={}) => row.consist || state.overview?.identities?.[id]?.label || `ATS ${String(id||"?").padStart(2,"0")}`;
const eventLabel = (code) => state.overview?.event_definitions?.[code]?.label || "Unknown code";
const positionText = position => position.status.replace(/\s*\([^)]*\)\s*$/, "").trim();
const eventDictionaryText = () => Object.entries(state.overview?.event_definitions || {}).map(([code,definition])=>`${code} ${definition.label}`).join(" · ");
const icon = (name) => {
  const paths={overview:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',map:'<path d="M4 4h5l6 16h5M4 20h5L15 4h5"/><circle cx="6" cy="4" r="2"/><circle cx="18" cy="20" r="2"/>',board:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10M7 12h10M7 16h5"/>',trains:'<rect x="5" y="3" width="14" height="16" rx="3"/><path d="M5 10h14M8 22l2-3m6 3-2-3M9 15h.01M15 15h.01"/>',events:'<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>',health:'<path d="M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6"/>',records:'<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 9h18M9 4v16M15 4v16M3 14h18"/>',play:'<path d="M8 5l11 7-11 7z"/>',pause:'<path d="M8 5v14M16 5v14"/>',prev:'<path d="M15 5l-7 7 7 7"/>',next:'<path d="M9 5l7 7-7 7"/>',close:'<path d="M6 6l12 12M6 18L18 6"/>'};
  paths.analytics='<path d="M4 4v16h16M8 16v-4m5 4V8m5 8V5"/>';
  return `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]||paths.overview}</svg>`;
};
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
  if (view==="map") renderTrackMap("track-map",true);
  if (view==="board") renderBoard();
  if (view==="trains") {renderTrains(); safe(loadHistory)();}
  if (view==="health") renderHealth();
  if (view==="records") safe(() => loadTable("record"))();
  if (view==="events") safe(() => loadTable("event"))();
  if (view==="analytics") safe(refreshAnalytics)();
}

function stopPlayback() {
  state.playing=false; clearTimeout(state.playTimer); $("play").innerHTML=icon("play"); $("play").setAttribute("aria-label","Play snapshots");
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
  if (state.view==="map") renderTrackMap("track-map",true);
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
  $("analytics-scope").value="all";
  $("analytics-folder").value="";
  $("analytics-file").value="";
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
  ].map(([label,value,note])=>`<article class="metric"><div class="metric-top"><span>${label}</span></div><strong>${value}</strong><small>${note}</small></article>`).join("");
  const files=selectedFiles();
  $("timeline").max=Math.max(0,files.length-1);
  $("range-start").textContent=clockText(s.first); $("range-end").textContent=clockText(s.last);
  const platforms=o.platforms.map(p=>({value:p.platform,label:`${p.platform} · ${stationName(p.platform)}`}));
  const trains=o.trains.map(t=>({value:t.train_id,label:trainLabel(t.train_id,t)}));
  ["record-train","event-train"].forEach(id=>fillSelect(id,trains,"All trains"));
  ["record-platform","event-platform"].forEach(id=>fillSelect(id,platforms,"All platforms"));
  fillSelect("history-train",trains); fillSelect("history-platform",platforms);
  fillSelect("event-code",o.event_codes.map(c=>({value:c.code,label:`${c.code} - ${eventLabel(c.code)} (${fmt(c.count)})` })),"All events");
  const analyticsEvent=$("analytics-event").value || "103";
  fillSelect("analytics-event",Object.keys(o.event_definitions).map(code=>({value:code,label:`${code} · ${eventLabel(code)}`})));
  $("analytics-event").value=analyticsEvent;
  const folders = [...new Set(o.snapshots.map(file => file.folder))].sort((a, b) => a.localeCompare(b));
  fillSelect("analytics-folder",folders.map(folder=>({value:folder,label:folder==="."?"Top-level folder":folder})),"Choose a folder");
  fillSelect("analytics-file",o.snapshots.map(file=>({value:String(file.id),label:file.name})),"Choose a file");
  $("event-definition-summary").textContent=`${eventDictionaryText()}.`;
  $("database-export").href=downloadURL("/api/database");
  $("database-location").textContent=`Workspace: ${state.db}. Use Rescan folder to update the collection. Save workspace includes all imported collections.`;
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
  renderTrackMap("line-map",false);
  const trains=groupedTrains();
  $("overview-trains").innerHTML=trains.length ? trains.map(([id,p])=>{
    const summary=trainSummary(p);
    return `<div class="train-row"><span class="train-token">${escapeHTML(trainLabel(id,p[0]))}</span><div class="train-info"><strong>${escapeHTML(summary.destinations.join(" / ") || "Destination unavailable")}</strong><span>${p.length} platform predictions · ATS ID ${escapeHTML(id)} · dir ${escapeHTML(summary.directions.join(" / ") || "—")}</span></div><button class="link" data-train="${escapeHTML(id)}">Inspect</button></div>`;
  }).join("") : empty(snap.status==="valid" ? "No train predictions reported in this snapshot." : "This snapshot has no readable prediction data. Open File health for details.");
  $("overview-trains").querySelectorAll("[data-train]").forEach(b=>b.onclick=()=>{$("history-train").value=b.dataset.train;setView("trains");});
  const flagged=snap.platforms.filter(p=>p.closed==="true"||p.held==="true");
  const notes=[
    ["Clock offset",`${$("clock").value} minutes between XML and filename times. Change this under Data source.`],
    [o.stats.invalid ? `${o.stats.invalid} empty or invalid snapshots` : "All snapshots readable",o.stats.invalid ? "Open File health to review the affected files." : `${fmt(o.stats.valid)} readable snapshots in this collection.`],
    [flagged.length ? `${flagged.length} held or closed platforms` : "Platform status",flagged.length ? flagged.map(p=>`${p.platform}: ${p.closed==="true"?"closed ":""}${p.held==="true"?"held":""}`).join(" · ") : "No held or closed platforms in this snapshot."],
    [`${fmt(o.stats.events)} events`,eventDictionaryText()]
  ];
  $("feed-notes").innerHTML=notes.map(([title,text])=>`<div class="note"><div><strong>${escapeHTML(title)}</strong><p>${escapeHTML(text)}</p></div></div>`).join("");
}

function renderTrackMap(target,details) {
  if(!state.snapshot)return;
  const snap=state.snapshot,data=snap.positions||{trains:[],unplaced:[]},stations=Object.entries(state.overview.station_names);
  const x=i=>145+i*94, end=x(stations.length-1), width=end+122, height=435;
  const tracks=[{number:1,suffix:"W",direction:"West",y:150},{number:2,suffix:"E",direction:"East",y:320}];
  let drawing="";
  for(const track of tracks) {
    drawing+=`<text class="track-name" x="16" y="${track.y-5}">Track ${track.number}</text><text class="track-subtitle" x="16" y="${track.y+15}">${track.direction}</text><line class="track-rail" x1="${x(0)}" x2="${end}" y1="${track.y-4}" y2="${track.y-4}"/><line class="track-rail" x1="${x(0)}" x2="${end}" y1="${track.y+4}" y2="${track.y+4}"/>`;
    stations.forEach(([code,name],i)=>{
      const p=snap.platforms.find(p=>p.platform===`${code}-${track.suffix}`),flag=p&&(p.closed==="true"||p.held==="true");
      const y=track.number===1 ? track.y+35 : track.y+35;
      const words=name.split(" "),lines=name.length>13&&words.length>1?[words.slice(0,-1).join(" "),words.at(-1)]:[name];
      drawing+=`<g class="track-station ${flag?"flagged":""}" data-map-station="${code}" tabindex="0" role="button" aria-label="${escapeHTML(name)}, track ${track.number}${flag?", platform held or closed":""}"><circle cx="${x(i)}" cy="${track.y}" r="7"/><text x="${x(i)}" y="${y}" text-anchor="middle">${lines.map((line,n)=>`<tspan x="${x(i)}" dy="${n?15:0}">${escapeHTML(line)}</tspan>`).join("")}</text><text class="track-subtitle" x="${x(i)}" y="${y+42}" text-anchor="middle">${code}-${track.suffix}</text></g>`;
    });
    const markers=data.trains.filter(t=>t.track===track.number).sort((a,b)=>a.position-b.position),lanes=[];
    markers.forEach((train,index)=>{
      const px=x(train.position),near=lanes.filter(p=>Math.abs(p.x-px)<85),lane=near.length?Math.max(...near.map(p=>p.lane))+1:0;
      lanes.push({x:px,lane});const py=track.y-28-lane*28,segment=train.method==="approach_segment";
      if(segment)drawing+=`<line class="track-uncertainty" x1="${x(train.segment[0])}" x2="${x(train.segment[1])}" y1="${track.y}" y2="${track.y}"/>`;
      drawing+=`<g class="track-train ${segment?"segment-estimate":""}" data-map-train="${escapeHTML(train.train_id)}" role="button" tabindex="0" aria-label="${escapeHTML(trainLabel(train.train_id,train))}, Track ${train.track}, ${escapeHTML(positionText(train))}"><title>${escapeHTML(trainLabel(train.train_id,train))}: ${escapeHTML(positionText(train))}</title><line x1="${px}" x2="${px}" y1="${py+12}" y2="${track.y}"/><rect x="${px-36}" y="${py-12}" width="72" height="24" rx="6"/><text x="${px}" y="${py+4}" text-anchor="middle">${escapeHTML(trainLabel(train.train_id,train))}</text></g>`;
    });
  }
  $(target).innerHTML=`<div class="track-scroll"><svg class="track-diagram" viewBox="0 0 ${width} ${height}" role="group" aria-label="Line 1 estimated train positions: Track 1 is West and Track 2 is East">${drawing}</svg></div><p class="footnote map-disclaimer">Filled marker: estimated position. Outlined marker: approaching within the highlighted segment.</p>`+(details?`<div class="map-evidence">${data.trains.map(t=>`<button class="position-card" data-map-train="${escapeHTML(t.train_id)}"><strong>${escapeHTML(trainLabel(t.train_id,t))}<span>Track ${t.track}</span></strong><p>${escapeHTML(positionText(t))}</p><small>View prediction</small></button>`).join("")}${data.unplaced.map(t=>`<div class="position-card unplaced"><strong>${escapeHTML(trainLabel(t.train_id,t))}<span>Not placed</span></strong><p>${escapeHTML(t.reason)}</p></div>`).join("")}</div>`:"");
  if(!data.trains.length)$(target).insertAdjacentHTML("beforeend",empty(snap.status!=="valid"?"No map data for this snapshot. Choose another snapshot.":"No train positions are available for this snapshot."));
  const activate=(element,action)=>{element.onclick=action;element.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();action();}};};
  $(target).querySelectorAll("[data-map-station]").forEach(b=>activate(b,()=>{$("board-search").value=b.dataset.mapStation;setView("board");}));
  $(target).querySelectorAll("[data-map-train]").forEach(b=>activate(b,()=>{
    const position=data.trains.find(t=>t.train_id===b.dataset.mapTrain),prediction=snap.predictions.find(p=>p.row_id===position?.prediction_row);
    modal(`${trainLabel(position.train_id,position)} · Track ${position.track}`,`<p>${escapeHTML(positionText(position))} · Estimated position</p><p>Track 1 is West; Track 2 is East.</p><div class="dialog-actions"><button class="button" id="map-record">Open prediction record</button><button class="button" id="map-train-history">Train history</button></div>${makeTable(["Prediction", "Value"], [["Platform",prediction?.platform||"—"],["Arrival (XML)",prediction?.arr||"—"],["Departure (XML)",prediction?.dep||"—"],["Next platform",prediction?.next_platform||"—"],["Captured",clockText(snap.capture)],["Source file",snap.name]])}`);
    $("map-record").onclick=()=>rowDetail(prediction,snap);$("map-train-history").onclick=()=>{$("detail").close();$("history-train").value=position.train_id;setView("trains");};
  }));
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
    return `<article class="panel board-card"><header><h3>${escapeHTML(stationName(p.platform))}</h3><code>${escapeHTML(p.platform)}</code></header><div class="platform-flags">${p.closed==="true"?badge("CLOSED","bad"):""}${p.held==="true"?badge("HELD","warn"):""}${p.closed!=="true"&&p.held!=="true"?badge(`${p.platform.split("-")[1] || "?"} PLATFORM`):""}</div>${predictions.length?predictions.map(r=>`<div class="arrival"><button class="train-token" data-board-row="${r.row_id}" aria-label="Inspect train ${escapeHTML(trainLabel(r.train_id,r))} prediction at ${escapeHTML(p.platform)}">${escapeHTML(trainLabel(r.train_id,r))}</button><div><strong>${escapeHTML(r.destination || "Destination unavailable")}</strong><small>arr ${shortTime(r.arr)} · dep ${shortTime(r.dep)}</small><small>${r.stop==="false"?"PASSING · ":""}${r.service==="false"?"serv=false · ":""}dir ${escapeHTML(r.direction||"—")} · next ${escapeHTML(r.next_platform||"—")}</small></div>${eta(r.eta_seconds)}</div>`).join(""):empty("No predictions reported")}</article>`;
  }).join("") : empty(snap.status!=="valid" ? "This snapshot is empty or invalid. Choose another capture to view platform data." : "No platforms match. Try another search or include platforms without predictions.");
  $("board").querySelectorAll("[data-board-row]").forEach(b=>b.onclick=()=>rowDetail(snap.predictions.find(r=>String(r.row_id)===b.dataset.boardRow),snap));
}

function renderTrains() {
  const current=new Map(groupedTrains());
  $("train-cards").innerHTML=state.overview.trains.map(train=>{
    const p=current.get(train.train_id)||[],s=trainSummary(p),selected=$("history-train").value===train.train_id;
    return `<button class="panel train-card ${selected?"selected":""}" data-pick-train="${escapeHTML(train.train_id)}"><span class="train-token">${escapeHTML(trainLabel(train.train_id,train))}</span><h3>${escapeHTML(trainLabel(train.train_id,train))}</h3><p>${p.length ? `${p.length} predictions in selected snapshot` : "Absent from selected snapshot"}<br>${escapeHTML(s.destinations.join(" / ")||"No destination in this snapshot")}<br>${fmt(train.snapshots)} snapshots across collection<br>Speed (raw): ${escapeHTML(s.speeds.join(" / ")||"—")} · Cars (raw): ${escapeHTML(s.cars.join(" / ")||"—")}</p></button>`;
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
  $("history-title").textContent=`${trainLabel(train)} · ${platform} prediction history`;
  $("history-export").href=downloadURL("/api/export",{kind:"predictions",train,platform});
  const points=data.rows.map(r=>({...r,x:wallMillis(r.capture),y:wallMillis(r.arr)})).filter(r=>Number.isFinite(r.x)&&Number.isFinite(r.y));
  if(points.length<2) $("history-chart").innerHTML=empty(points.length ? "Add more snapshots to view a prediction history chart." : "No timestamped predictions for this train and platform.");
  else {
    const W=900,H=240,L=90,R=25,T=15,B=35,xmin=Math.min(...points.map(p=>p.x)),xmax=Math.max(...points.map(p=>p.x)),ymin=Math.min(...points.map(p=>p.y)),ymax=Math.max(...points.map(p=>p.y));
    const x=v=>L+(v-xmin)/(xmax-xmin||1)*(W-L-R), y=v=>H-B-(v-ymin)/(ymax-ymin||1)*(H-T-B);
    let grid="";
    for(let i=0;i<5;i++) {const v=ymin+(ymax-ymin)*i/4,py=y(v);grid+=`<line class="chart-grid" x1="${L}" y1="${py}" x2="${W-R}" y2="${py}"/><text class="chart-label" x="${L-10}" y="${py+3}" text-anchor="end">${new Date(v).toISOString().slice(11,19)}</text>`;}
    for(let i=0;i<4;i++) {const v=xmin+(xmax-xmin)*i/3,px=x(v);grid+=`<text class="chart-label" x="${px}" y="${H-12}" text-anchor="middle">${new Date(v).toISOString().slice(11,19)}</text>`;}
    // Points only: no connecting line across missing snapshots or changing runs.
    const marks=points.map(p=>`<circle class="chart-point" cx="${x(p.x)}" cy="${y(p.y)}" r="2.5"><title>Capture ${escapeHTML(p.capture)}; predicted arrival ${escapeHTML(p.arr)}</title></circle>`).join("");
    $("history-chart").innerHTML=`<p class="table-meta">Y: predicted arrival (XML clock) · X: capture (filename clock) · ${fmt(points.length)} plotted / ${fmt(data.total)} matching records</p><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Predicted arrival times for ${escapeHTML(trainLabel(train))} at ${escapeHTML(platform)} across captured snapshots">${grid}${marks}</svg>`;
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
    headers=["Capture (filename)","Platform","Train","ATS ID","Arrival (XML)","Departure (XML)","Destination","Next","Dir","Stop","Serv","Speed (raw)","Cars (raw)"];
    records=result.rows.map(r=>[clockText(r.capture),r.platform,trainLabel(r.train_id,r),r.train_id,r.arr||"—",r.dep||"—",r.destination||"—",r.next_platform||"—",r.direction||"—",r.stop??"—",r.service??"—",r.speed??"—",r.cars??"—"]);
  } else {
    headers=["Event time (XML)","Event","Code","Platform","Train","ATS ID","Vehicle IDs (source order)","Captured (filename)","Source file"];
    records=result.rows.map(r=>[r.time||"—",r.event_label,r.code||"—",r.platform||"—",trainLabel(r.train_id,r),r.train_id||"—",r.vehicles.join(" / "),clockText(r.capture),basename(r.source)]);
  }
  $(`${prefix}-table`).innerHTML=makeTable(headers,records,result.rows.map((r,i)=>`data-detail="${i}" tabindex="0" role="button" aria-label="Open ${prefix} source record ${i+1}"`));
  $(`${prefix}-table`).querySelectorAll("[data-detail]").forEach(tr=>{
    const open=()=>rowDetail(result.rows[Number(tr.dataset.detail)],null);
    tr.onclick=open;tr.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();open();}};
  });
  pagination(prefix,result.total,100,()=>loadTable(prefix));
}

async function refreshAnalytics() {
  const request = ++state.analyticsRequest;
  const overview = state.overview;
  const scope = $("analytics-scope").value;
  const source = $("analytics-source");
  const results = $("analytics-results");
  const folderSelect = $("analytics-folder");
  const fileSelect = $("analytics-file");
  $("analytics-folder-control").classList.toggle("hidden", scope !== "folder");
  $("analytics-file-control").classList.toggle("hidden", scope !== "file");
  results.classList.add("hidden");
  state.analyticsCounts = null;

  let files = overview.snapshots;
  let label = `Whole collection · ${fmt(files.length)} source files`;
  let filter = null;
  if (scope === "folder") {
    if (!folderSelect.value) {
      const current = files.find(file => file.id === state.snapshot?.id);
      folderSelect.value = (current || files[0]).folder;
    }
    const folder = folderSelect.value;
    files = files.filter(file => file.folder === folder);
    label = `${folderSelect.selectedOptions[0].textContent} · ${fmt(files.length)} files directly in this folder`;
    filter = {folder};
  } else if (scope === "file") {
    if (!fileSelect.value) fileSelect.value = String(state.snapshot?.id ?? files[0].id);
    const file = files.find(file => file.id === Number(fileSelect.value));
    files = [file];
    label = file.name;
    filter = {snapshot:file.id};
  }

  source.textContent = label;
  if (!files.some(file => file.status === "valid")) {
    source.textContent += " · No readable snapshots in this selection.";
    return;
  }
  source.textContent = filter ? `${label} · Counting events…` : label;
  try {
    const counts = filter ? await api("/api/event-counts", {dataset:state.dataset,...filter}) : overview.event_counts;
    if (request !== state.analyticsRequest || overview !== state.overview) return;
    state.analyticsCounts = counts;
    source.textContent = label;
    renderAnalytics();
    results.classList.remove("hidden");
  } catch (error) {
    if (request === state.analyticsRequest && overview === state.overview) source.textContent = `${label} · ${error.message}`;
  }
}

function renderAnalytics() {
  if (!state.analyticsCounts) return;
  const {event_definitions, station_names} = state.overview;
  const codes = Object.keys(event_definitions);
  const selected = $("analytics-event").value;
  const track = $("analytics-track").value;
  const sort = $("analytics-order").value;
  const stations = Object.entries(station_names).map(([code, name]) => ({code, name, counts: {}}));
  const byPlatform = new Map(stations.flatMap(station => [
    [`${station.code}-W`, station], [`${station.code}-E`, station]
  ]));

  let unmapped = 0;
  for (const {platform, code, count} of state.analyticsCounts) {
    if (!codes.includes(code)) continue;
    const station = byPlatform.get(platform);
    if (!station) {
      if (code === selected) unmapped += count;
      continue;
    }
    if (track && !platform.endsWith(`-${track}`)) continue;
    station.counts[code] = (station.counts[code] || 0) + count;
  }

  const selectedCount = station => station.counts[selected] || 0;
  const ranked = [...stations].sort((a, b) => selectedCount(a) - selectedCount(b));
  const minimum = selectedCount(ranked[0]);
  const lowest = ranked.filter(station => selectedCount(station) === minimum);
  const smallestNonzero = ranked.find(station => selectedCount(station) > 0);
  const nonzeroMinimum = smallestNonzero ? selectedCount(smallestNonzero) : null;
  const lowestNonzero = nonzeroMinimum === null ? [] : ranked.filter(station => selectedCount(station) === nonzeroMinimum);
  const stationNote = group => group.length === 1 ? group[0].name : `${fmt(group.length)} stations tied`;
  const eventTotal = ranked.reduce((sum, station) => sum + selectedCount(station), 0);
  $("analytics-summary").innerHTML = [
    [`${eventLabel(selected)} (${selected}) records`, eventTotal, "At mapped stations"],
    ["Fewest at a station", minimum, stationNote(lowest)],
    ["Fewest where recorded", nonzeroMinimum, lowestNonzero.length ? stationNote(lowestNonzero) : "No records for this code"]
  ].map(([label, value, note]) => `<article class="panel health-card"><span>${escapeHTML(label)}</span><strong>${value === null ? "—" : fmt(value)}</strong><small>${escapeHTML(note)}</small></article>`).join("");
  $("analytics-unmapped").textContent = `${fmt(unmapped)} records for code ${selected} in this selection have no mapped Line 1 platform.`;
  $("analytics-unmapped").classList.toggle("hidden", unmapped === 0);

  const order = sort === "ascending" ? 1 : -1;
  const display = [...stations].sort((a, b) => order * (selectedCount(a) - selectedCount(b)));
  const header = codes.map(code => `<th scope="col" ${code === selected ? `class="ranked-event" aria-sort="${sort}"` : ""}>${escapeHTML(`${code} ${eventLabel(code)}`)}</th>`).join("");
  const body = display.map(({code, name, counts}) => `<tr>
    <th scope="row">${escapeHTML(name)} <span class="muted">${escapeHTML(code)}</span></th>
    ${codes.map(event => `<td class="${event === selected ? "ranked-event" : ""}">${fmt(counts[event] || 0)}</td>`).join("")}
  </tr>`).join("");
  $("analytics-table").innerHTML = `<table class="analytics-table" aria-label="ATS event counts by station">
    <thead><tr><th scope="col">Station</th>${header}</tr></thead><tbody>${body}</tbody>
  </table>`;
}

function renderHealth() {
  const o=state.overview,s=o.stats;
  $("health-summary").innerHTML=[[s.invalid,"Empty / invalid files"],[s.duplicates,"Duplicate copies excluded"],[o.gaps.length,`Gaps over ${s.gap_threshold}s`]].map(([n,label])=>`<article class="panel health-card"><strong>${fmt(n)}</strong><span>${escapeHTML(label)}</span></article>`).join("");
  $("coverage").innerHTML=o.snapshots.map(f=>`<button class="${f.duplicate_of?"duplicate":f.status} ${f.id===state.snapshot?.id?"current":""}" data-file="${f.id}" title="${escapeHTML(`${f.name} · ${f.duplicate_of?"duplicate":f.status}`)}" aria-label="${escapeHTML(`${f.name}, ${f.duplicate_of?"duplicate":f.status}`)}"></button>`).join("");
  $("coverage").querySelectorAll("[data-file]").forEach(b=>b.onclick=safe(()=>openSnapshot(Number(b.dataset.file))));
  $("gaps").innerHTML=o.gaps.length ? o.gaps.map(g=>`<p class="gap-note warn-text">${escapeHTML(clockText(g.from))} → ${escapeHTML(clockText(g.to))}: ${g.seconds}s between readable captures</p>`).join("") : `<p class="gap-note muted">No capture gaps over ${s.gap_threshold}s. Gap threshold: 60 seconds or 3× the median capture interval, whichever is greater.</p>`;
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
  modal(`${trainLabel(row.train_id,row)} · ${row.platform || "unknown platform"}`,`<p>Source: ${escapeHTML(row.source||snapshot?.name||"Selected snapshot")}<br>Capture (filename): ${escapeHTML(row.capture||snapshot?.capture||"unknown")}</p><div class="dialog-actions"><button class="button" id="modal-source">View original XML</button><button class="button" id="modal-snapshot">Go to snapshot</button></div><p>Train: ${escapeHTML(trainLabel(row.train_id,row))} · ATS ID: ${escapeHTML(row.train_id)}${row.code?` · ${escapeHTML(row.code)} ${escapeHTML(row.event_label)}`:""}</p><h3>XML fields</h3><pre>${escapeHTML(JSON.stringify(row.raw,null,2))}</pre>`);
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
  modal("Original XML · source preview",`<p>${escapeHTML(file?.name||"Snapshot")}</p><a class="button" href="${escapeHTML(downloadURL("/api/raw",{id:sid,download:1}))}" download>Download original XML</a><pre>${escapeHTML(preview)}</pre>`);
}

function fillRecent(datasets) {
  $("recent-wrap").classList.toggle("hidden",!datasets.length);
  $("recent").innerHTML=optionHTML(datasets.map(d=>({value:d.id,label:basename(d.path)})),"Choose a saved collection");
  state.recent=datasets;
}

document.querySelectorAll("[data-icon]").forEach(el=>el.innerHTML=icon(el.dataset.icon));
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
  state.playing=true;$("play").innerHTML=icon("pause");$("play").setAttribute("aria-label","Pause playback");await playNext();
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
for (const id of ["analytics-event", "analytics-track", "analytics-order"]) $(id).onchange = renderAnalytics;
for (const id of ["analytics-scope", "analytics-folder", "analytics-file"]) $(id).onchange = safe(refreshAnalytics);
$("close-detail").onclick=()=>$("detail").close();
$("detail").onclick=e=>{if(e.target===$("detail")){const r=$("detail").getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$("detail").close();}};
$("help").onclick=()=>modal("Viewer guide",`
  <h3>Open and update a collection</h3>
  <p>Choose a folder of XML snapshots or a ZIP archive. Use Rescan folder to load changes, or enable Follow new files to refresh every 10 seconds.</p>
  <h3>Playback and track map</h3>
  <p>Drag the timeline or press Play to move through the snapshots. The map covers Tunney’s Pasture to Trim. Track 1 is West; Track 2 is East. Filled markers show estimated positions; outlined markers show trains approaching within a highlighted segment. Select a train for its prediction details, or a station for its platform board.</p>
  <h3>Clock alignment</h3>
  <p>Capture times come from filenames such as <code>tp_YYYYMMDDHHMMSS.xml</code>. Set the XML clock minus the filename clock under Data source. The default is +240 minutes; use 0 if both clocks match. Countdown = predicted arrival − adjusted capture time. For periods spanning a clock change, load each period with its corresponding offset.</p>
  <h3>Train and station views</h3>
  <p>Train numbers such as 06-40 identify coupled vehicles. Select a train and platform to compare arrival predictions across captures. Use the station board to view upcoming calls, held platforms, and closures. Negative countdowns indicate times before the selected snapshot.</p>
  <h3>Events</h3>
  <p>${escapeHTML(eventDictionaryText() || "100 Arrived · 101 Arriving · 102 Departing · 103 Departed")}. Search by train or vehicle number, platform, or event code. Select a row for its XML fields.</p>
  <p>Use Analytics to compare event counts by station for the whole collection, one folder, or one file. Choose an event code to rank the stations and a track to narrow the counts.</p>
  <h3>Event review priorities</h3>
  <p>At termini, prioritize 103, 102, 100, then 101. At other stations, prioritize 100, 101, 103, then 102. Event 103 identifies trip departure at a terminus. Event 102 is train-triggered and counts can vary. Review event coverage over the relevant revenue-service period.</p>
  <h3>File health</h3>
  <p>Green blocks are readable snapshots, red blocks are empty or invalid files, and gray blocks are duplicate copies. Select a block to open the snapshot. Duplicate copies with the same content and capture time count once in collection totals.</p>
  <h3>Exports and saved workspaces</h3>
  <p>Export CSV downloads all records matching the current filters. Save workspace creates a SQLite file containing all imported collections. To reopen a saved workspace, start the viewer with <code>python -m ats_viewer --database /path/to/ats-workspace.sqlite --open</code>, then select the collection under Recent.</p>
`);

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
