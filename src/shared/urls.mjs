// Finds web addresses in an agent instruction. Shared by the server (site scout) and the browser (address chips).
const FILE_NAME=/\.(png|jpe?g|webp|gif|svg|ico|avif|md|mjs|js|ts|json|css|html?|txt|pdf|zip|docx?|xlsx?|pptx?)$/i;
const CANDIDATE=/(?:https?:\/\/[^\s<>"'«»]+|www\.[^\s<>"'«»]+|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?:\/[^\s<>"'«»]*)?)/gi;

export function findUrls(text='',limit=3) {
  const source=String(text),found=[];
  for(const match of source.matchAll(CANDIDATE)) {
    const before=source[match.index-1]||'';
    if(before==='@'||/[\w.:/-]/.test(before))continue;
    const trimmed=match[0].replace(/[.,;:!?)\]»]+$/,'');
    const explicit=/^https?:\/\//i.test(trimmed);
    let url;try{url=new URL(explicit?trimmed:`https://${trimmed}`);}catch{continue;}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)continue;
    if(!/\.[a-z]{2,24}$/i.test(url.hostname))continue;
    if(!explicit&&url.pathname==='/'&&!url.search&&FILE_NAME.test(url.hostname))continue;
    if(!found.includes(url.href))found.push(url.href);
    if(found.length>=limit)break;
  }
  return found;
}
