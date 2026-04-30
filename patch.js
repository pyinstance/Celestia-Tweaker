const fs=require('fs');
const path='/mnt/data/profile_fix_bw/src/index.html';
let s=fs.readFileSync(path,'utf8');
const css=`

body.theme-celestia,body.theme-mono{
  --bg:#050505;--bg2:rgba(12,12,12,.82);--bg3:rgba(22,22,22,.76);--bg4:#252525;
  --p:#f5f5f5;--p2:#ffffff;--p3:#bdbdbd;--p4:#8a8a8a;
  --p-dim:rgba(255,255,255,.065);--p-glow:rgba(255,255,255,.13);--p-border:rgba(255,255,255,.20);
  --border:rgba(255,255,255,.075);--border2:rgba(255,255,255,.13);
  --theme-bg:radial-gradient(circle at 72% 0%,rgba(255,255,255,.065),transparent 34%),radial-gradient(circle at 0% 100%,rgba(255,255,255,.035),transparent 38%),linear-gradient(180deg,#070707,#020202);
  --theme-main:radial-gradient(circle at 78% 8%,rgba(255,255,255,.045),transparent 32%),linear-gradient(180deg,#080808,#030303);
  --theme-panel:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,.022));
  --theme-button:linear-gradient(135deg,#f5f5f5,#aeb4c0);
  --theme-login:radial-gradient(circle at 50% 18%,rgba(255,255,255,.075),transparent 32%),linear-gradient(180deg,#080808,#030303);
}
body.theme-celestia .tb-wordmark,body.theme-mono .tb-wordmark,
body.theme-celestia .splash-wordmark,body.theme-mono .splash-wordmark{
  background:linear-gradient(135deg,#fff 20%,#9ca3af);-webkit-background-clip:text;-webkit-text-fill-color:transparent;
}
body.theme-celestia .btn-apply,body.theme-celestia .btn-login,body.theme-mono .btn-apply,body.theme-mono .btn-login{color:#050505}
body.theme-celestia .nav-item.active,body.theme-mono .nav-item.active{background:rgba(255,255,255,.075);border-color:rgba(255,255,255,.20)}
body.theme-celestia .nav-item.active .ni-icon path,body.theme-celestia .nav-item.active .ni-icon circle,body.theme-celestia .nav-item.active .ni-icon rect,body.theme-celestia .nav-item.active .ni-icon line,body.theme-celestia .nav-item.active .ni-icon polyline,
body.theme-mono .nav-item.active .ni-icon path,body.theme-mono .nav-item.active .ni-icon circle,body.theme-mono .nav-item.active .ni-icon rect,body.theme-mono .nav-item.active .ni-icon line,body.theme-mono .nav-item.active .ni-icon polyline{stroke:#fff}
body.theme-celestia .sr-val,body.theme-mono .sr-val{color:#f5f5f5}
body.theme-celestia .tag-p,body.theme-mono .tag-p{background:rgba(255,255,255,.07);color:#fff;border-color:rgba(255,255,255,.16)}
body.theme-celestia .al-row,body.theme-mono .al-row{background:rgba(255,255,255,.045);border-color:rgba(255,255,255,.09)}
body.theme-celestia .al-dot,body.theme-mono .al-dot{background:#fff;box-shadow:0 0 14px rgba(255,255,255,.4)}
.profile-glass-head{background:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,.024));border:1px solid rgba(255,255,255,.09);border-radius:24px;padding:24px;display:flex;align-items:center;gap:20px;margin-bottom:14px;box-shadow:0 28px 80px rgba(0,0,0,.28);backdrop-filter:blur(34px)}
.profile-accordion{display:grid;gap:10px}
.profile-drop{border:1px solid rgba(255,255,255,.085);border-radius:18px;background:linear-gradient(180deg,rgba(255,255,255,.047),rgba(255,255,255,.018));overflow:hidden;box-shadow:0 16px 54px rgba(0,0,0,.22);backdrop-filter:blur(28px)}
.profile-drop.open{border-color:rgba(255,255,255,.18);background:linear-gradient(180deg,rgba(255,255,255,.065),rgba(255,255,255,.022))}
.profile-drop-head{width:100%;background:transparent;border:0;color:var(--t);font-family:var(--font);display:flex;align-items:center;justify-content:space-between;gap:14px;padding:16px 18px;cursor:pointer;text-align:left}
.profile-drop-title{display:flex;flex-direction:column;gap:4px}
.profile-drop-title b{font-size:14px;letter-spacing:-.02em}
.profile-drop-title span{font-size:11px;color:var(--t3)}
.profile-drop-icon{width:28px;height:28px;border:1px solid rgba(255,255,255,.12);border-radius:10px;display:grid;place-items:center;color:var(--t2);transition:transform .18s ease,background .18s ease}
.profile-drop.open .profile-drop-icon{transform:rotate(180deg);background:rgba(255,255,255,.06)}
.profile-drop-body{display:none;padding:0 18px 18px}
.profile-drop.open .profile-drop-body{display:block;animation:profileDrop .18s ease both}
.profile-info-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.profile-info-pill{border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:13px;background:rgba(255,255,255,.026)}
.profile-info-pill span{display:block;font-size:9px;color:var(--t3);font-family:var(--mono);text-transform:uppercase;letter-spacing:.09em;margin-bottom:6px}
.profile-info-pill b{display:block;font-size:20px;letter-spacing:-.05em;color:var(--t)}
.profile-actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:12px}
@keyframes profileDrop{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
@media(max-width:760px){.profile-glass-head{align-items:flex-start;flex-direction:column}.profile-info-grid{grid-template-columns:1fr}}
`;
s=s.replace('</style>',css+'\n</style>');
const start=s.indexOf('      <div class="page" id="page-profile">');
const end=s.indexOf('\n\n    </div>\n  </div>\n</div>\n\n<div id="celModal"', start);
if(start<0||end<0) throw new Error('profile block not found');
const profile=`      <div class="page" id="page-profile">
        <div class="ph"><div class="ph-title">Profile</div><div class="ph-sub">Account, activity and local controls</div></div>

        <div class="profile-glass-head">
          <div class="p-avatar-wrap">
            <img id="profileAvatar" class="p-avatar" src="" alt="" style="display:none"/>
            <div class="p-avatar" id="profileAvatarFb" style="display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:700;background:linear-gradient(135deg,#f5f5f5,#9ca3af);color:#050505;font-family:var(--font)">?</div>
            <div class="p-avatar-ring"></div>
          </div>
          <div class="p-info">
            <div class="p-name" id="profileName">—</div>
            <div class="p-discriminator" id="profileDiscrim">#0000</div>
            <div class="p-id" id="profileIdTxt">ID: —</div>
            <div class="p-tags">
              <span class="p-tag tag-p">Celestia user</span>
              <span class="p-tag tag-w" id="profileJoined">—</span>
              <span class="p-tag tag-w" id="profileFlags">flags: 0</span>
            </div>
          </div>
        </div>

        <div class="profile-accordion">
          <div class="profile-drop open">
            <button class="profile-drop-head" onclick="toggleProfileDrop(this)"><div class="profile-drop-title"><b>Overview</b><span>Your current optimisation snapshot</span></div><div class="profile-drop-icon">⌄</div></button>
            <div class="profile-drop-body">
              <div class="profile-info-grid">
                <div class="profile-info-pill"><span>Tweaks active</span><b id="prActive">0</b></div>
                <div class="profile-info-pill"><span>Total applied</span><b id="prApplied">0</b></div>
                <div class="profile-info-pill"><span>Performance score</span><b id="prScore">—</b></div>
              </div>
            </div>
          </div>

          <div class="profile-drop">
            <button class="profile-drop-head" onclick="toggleProfileDrop(this)"><div class="profile-drop-title"><b>Recent activity</b><span>Latest actions saved locally</span></div><div class="profile-drop-icon">⌄</div></button>
            <div class="profile-drop-body">
              <div class="log-toolbar"><div class="card-label">Activity log</div><button class="btn-ghost" onclick="clearActivityHistory()" style="font-size:11px;padding:8px 12px;">Clear log</button></div>
              <div class="history-list tall" id="historyList"><div class="history-item"><span>No activity yet</span><span>—</span></div></div>
            </div>
          </div>

          <div class="profile-drop">
            <button class="profile-drop-head" onclick="toggleProfileDrop(this)"><div class="profile-drop-title"><b>Active tweaks</b><span>Everything currently enabled</span></div><div class="profile-drop-icon">⌄</div></button>
            <div class="profile-drop-body">
              <div class="active-list" id="profileList"><div style="font-size:12px;color:var(--t3);padding:8px 0;">No tweaks enabled yet</div></div>
            </div>
          </div>

          <div class="profile-drop">
            <button class="profile-drop-head" onclick="toggleProfileDrop(this)"><div class="profile-drop-title"><b>Profile tools</b><span>Export, reset and account actions</span></div><div class="profile-drop-icon">⌄</div></button>
            <div class="profile-drop-body">
              <div class="profile-actions">
                <button class="btn-apply" onclick="exportReport()">Export report</button>
                <button class="btn-ghost" onclick="undoLastChange()">Undo last change</button>
                <button class="btn-ghost" onclick="goPage('settings')">Open settings</button>
                <button class="btn-ghost danger" onclick="factoryResetLocal()">Reset local data</button>
              </div>
            </div>
          </div>
        </div>
      </div>`;
s=s.slice(0,start)+profile+s.slice(end);
s=s.replace("var base = { autoOptimize:false, confirmRisk:true, autoVerify:true, saveHistory:true, scanOnStartup:false, serviceConfirm:true, reducedMotion:false, compactMode:false, loginEffects:true, theme:'celestia' };","var base = { autoOptimize:false, confirmRisk:true, autoVerify:true, saveHistory:true, scanOnStartup:false, serviceConfirm:true, reducedMotion:false, compactMode:false, loginEffects:true, theme:'mono' };");
s=s.replace("base[k] = k === 'theme' ? String(saved[k] || 'celestia') : !!saved[k];","base[k] = k === 'theme' ? String(saved[k] || 'mono') : !!saved[k];");
s=s.replace("if (!/^(celestia|midnight|aurora|solar|mono|light)$/.test(base.theme)) base.theme = 'celestia';","if (!/^(celestia|midnight|aurora|solar|mono|light)$/.test(base.theme)) base.theme = 'mono';");
s=s.replace("(celSettings.theme || 'celestia')","(celSettings.theme || 'mono')");
const js=`
function toggleProfileDrop(btn) {
  var box = btn && btn.closest ? btn.closest('.profile-drop') : null;
  if (!box) return;
  box.classList.toggle('open');
}
`;
s=s.replace('\nfunction updateAll() {',js+'\nfunction updateAll() {');
fs.writeFileSync(path,s);
