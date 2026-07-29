// emoji-picker.js — shared emoji panel used by the chat room and PM pages.
// "Animated" tab reuses the same glyphs with a CSS animation applied, since we don't
// bundle actual animated GIF/APNG assets — swap ANIMATED_EMOJIS for real asset URLs
// (rendered as <img> tags instead of text) if you add a real emoji/sticker library.

const STATIC_EMOJIS = ['😀','😂','😍','😎','🙂','😉','😢','😡','😴','🤔','👍','👎','👏','🙏','💪','🎉','❤️','🔥','⭐','✨','🎁','☕','🍕','⚽','🎮','📚','🌙','☀️','🌧️','🐱'];
const ANIMATED_EMOJIS = ['😀','😂','😍','🎉','❤️','🔥','⭐','✨','🎁','👏','💪','🙌','🥳','😢','😡','🤔'];

// Numbered emoji database — type :100, :101, etc. in chat and it renders as the emoji below.
// Also used for /face :100 to set an emoji as your avatar.
const EMOJI_CODE_MAP = {
  100:'😀',101:'😃',102:'😄',103:'😁',104:'😆',105:'😅',106:'🤣',107:'😂',108:'🙂',109:'😉',
  110:'😊',111:'😇',112:'🥰',113:'😍',114:'🤩',115:'😘',116:'😗',117:'😋',118:'😛',119:'😜',
  120:'🤪',121:'😝',122:'🤑',123:'🤗',124:'🤭',125:'🤫',126:'🤔',127:'🤐',128:'🤨',129:'😐',
  130:'😑',131:'😶',132:'😏',133:'😒',134:'🙄',135:'😬',136:'🤥',137:'😌',138:'😔',139:'😪',
  140:'🤤',141:'😴',142:'😷',143:'🤒',144:'🤕',145:'🤢',146:'🤮',147:'🥵',148:'🥶',149:'😵',
  150:'🤯',151:'🤠',152:'🥳',153:'😎',154:'🤓',155:'🧐',156:'😕',157:'😟',158:'🙁',159:'😮',
  160:'😯',161:'😲',162:'😳',163:'🥺',164:'😦',165:'😧',166:'😨',167:'😰',168:'😥',169:'😢',
  170:'😭',171:'😱',172:'😖',173:'😣',174:'😞',175:'😓',176:'😩',177:'😫',178:'🥱',179:'😤',
  180:'😡',181:'😠',182:'🤬',183:'👍',184:'👎',185:'👏',186:'🙌',187:'🙏',188:'💪',189:'🤝',
  190:'❤️',191:'🧡',192:'💛',193:'💚',194:'💙',195:'💜',196:'🖤',197:'🤍',198:'💔',199:'💯'
};

function substituteEmojiCodes(text){
  return text.replace(/:(\d{3})\b/g, (match, num) => EMOJI_CODE_MAP[num] || match);
}
function resolveAvatarEmoji(code){
  if(!code) return '';
  const m = code.match(/^:?(\d{3})$/);
  if(m) return EMOJI_CODE_MAP[m[1]] || '';
  return code; // already a literal emoji character
}

function buildEmojiPicker(containerEl, onPick){
  containerEl.innerHTML = `
    <div class="emoji-tabs">
      <div class="emoji-tab active" data-tab="static">Static</div>
      <div class="emoji-tab" data-tab="animated">Animated</div>
    </div>
    <div class="emoji-grid" id="emoji-grid-static"></div>
    <div class="emoji-grid" id="emoji-grid-animated" style="display:none;"></div>
  `;

  const staticGrid = containerEl.querySelector('#emoji-grid-static');
  const animGrid = containerEl.querySelector('#emoji-grid-animated');

  STATIC_EMOJIS.forEach(e => {
    const span = document.createElement('span');
    span.className = 'emoji-item';
    span.textContent = e;
    span.addEventListener('click', () => onPick(e));
    staticGrid.appendChild(span);
  });

  ANIMATED_EMOJIS.forEach(e => {
    const span = document.createElement('span');
    span.className = 'emoji-item emoji-anim';
    span.textContent = e;
    span.addEventListener('click', () => onPick(e));
    animGrid.appendChild(span);
  });

  containerEl.querySelectorAll('.emoji-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      containerEl.querySelectorAll('.emoji-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      staticGrid.style.display = tab.dataset.tab === 'static' ? 'grid' : 'none';
      animGrid.style.display = tab.dataset.tab === 'animated' ? 'grid' : 'none';
    });
  });
}
