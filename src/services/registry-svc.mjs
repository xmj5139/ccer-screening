/** 官方注册登记系统公开项目同步。接口由公开页面当前前端调用；页面改版时须重新核验。 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { all, get, run, audit, dbPath } from '../core/db.mjs';
import { newId, nowIso, j } from '../core/util.mjs';
import { fetchText, recordSnapshot, sha256, loopbackOutboundAllowed } from './collect-svc.mjs';
import { parsePdfDocument } from './pdf-parse-svc.mjs';

export const REGISTRY_PAGE = 'https://ccer.cets.org.cn/projectPublicity/projectPublicityList';
/** 官方源站（**固定**；后台没有任何入口可以把它改到私网/自建地址） */
export const REGISTRY_OFFICIAL_ORIGIN = 'https://ccer.cets.org.cn';
const ORIGIN = REGISTRY_OFFICIAL_ORIGIN;

/**
 * 运行时源站：生产恒为官方源站。
 * `CCER_REGISTRY_BASE_URL` 只在显式允许回环出站（`CCER_ALLOW_LOOPBACK_OUTBOUND=1`，
 * 仅自动化测试/本机联调设置）时才被采用，用于把「0 行 → parse gap，任务不判成功」
 * 这类分支放到可重复的本机 HTTP stub 上做端到端回归。
 */
export function registryOrigin() {
  const raw = process.env.CCER_REGISTRY_BASE_URL;
  if (!raw) return ORIGIN;
  if (!loopbackOutboundAllowed()) return ORIGIN;
  try {
    new URL(String(raw).trim());
    return String(raw).trim().replace(/\/+$/, '');
  } catch {
    return ORIGIN;
  }
}

/** 当前源站对应的出站白名单（默认只有官方域名）。 */
export function registryAllowedDomains() {
  try {
    return [new URL(registryOrigin()).hostname];
  } catch {
    return ['ccer.cets.org.cn'];
  }
}

const LIST = () => `${registryOrigin()}/api/projectmanage/open/getOpeningApply`;
const DETAIL = () => `${registryOrigin()}/api/projectmanage/open/getOpeningApplyDetail`;
const TYPES = ['1', '1-1', '2', '3', '3-1', '4', '6'];
const FILE_KEYS = ['applyFile1','applyFile2','applyFile3','applyFile4','applyFile5','applyFile6',
  'certificationFile1','certificationFile2','certificationFile3','certificationFile4','certificationFile5','certificationFile6',
  'projectFilePath','certificationFilePath','regFilePath','orgCheckFile','registerAuditFilePath'];
const HEADERS = { referer: REGISTRY_PAGE, 'content-type': 'application/json' };

function ymd(v) {
  const s = String(v || '');
  return /^\d{8}/.test(s) ? `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` : null;
}
function jsonResponse(res) {
  if (!res.ok) throw new Error(res.error || '官方接口请求失败');
  let x;
  try { x = JSON.parse(res.body); } catch { throw new Error('官方接口未返回 JSON'); }
  if (x.flag !== '1' && x.successful !== true) throw new Error(x.msg || '官方接口返回失败');
  return x;
}
async function post(url, payload) {
  const res = await fetchText(url, { method: 'POST', body: JSON.stringify(payload), headers: HEADERS,
    allowedDomains: registryAllowedDomains(), rateLimitPerMin: 90, timeoutMs: 25000 });
  return { data: jsonResponse(res), res };
}
export function detailUrl(row) {
  const q = new URLSearchParams();
  for (const key of ['applyId','ccerId','certificationId','dataType','projectInfoId','applyStatus']) {
    if (row[key] !== null && row[key] !== undefined) q.set(key, String(row[key]));
  }
  return `${registryOrigin()}/projectPublicity/projectPublicityDetail?${q}`;
}
export function parseFiles(detail) {
  const found = new Map();
  for (const key of FILE_KEYS) {
    let value = detail[key];
    if (!value) continue;
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { continue; } }
    const entries = Array.isArray(value) ? value : [value];
    for (const f of entries) {
      if (!f || typeof f !== 'object') continue;
      const rel = f.url || f.fileUrl;
      if (!rel) continue;
      let url;
      try { url = new URL(rel, registryOrigin()); } catch { continue; }
      if (url.origin !== registryOrigin() || !url.pathname.startsWith('/api/file/download/')) continue;
      found.set(url.href, { name: String(f.name || f.fileName || `${key}.pdf`), url: url.href, doc_type: key });
    }
  }
  return [...found.values()];
}
function stage(type) {
  return {
    stage_project_public: ['1','1-1','2','3','3-1','4'].includes(type) ? 1 : 0,
    stage_project_registered: ['2','3','3-1','4'].includes(type) ? 1 : 0,
    stage_reduction_public: ['3','3-1','4'].includes(type) ? 1 : 0,
    stage_reduction_registered: type === '4' ? 1 : 0,
    stage_cancelled: type === '6' ? 1 : 0,
    current_stage: ({'1':'project_public','1-1':'project_public','2':'project_registered',
      '3':'reduction_public','3-1':'reduction_public','4':'reduction_registered','6':'cancelled'})[type],
  };
}
function numberOrNull(v) { return v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v); }
function upsertProject(row, detail, type, snapshotId, changed=true) {
  const id = `REG-${row.applyId}`;
  const old = get('SELECT * FROM public_project WHERE id = ?', [id]);
  const flags = stage(type);
  const now = nowIso();
  const methodology = String(detail.methodologyNum || '').match(/CCER[-—–]\d{2}[-—–]\d{3}/)?.[0]?.replace(/[—–]/g,'-') || null;
  const values = {
    name: detail.projectName || row.projectName,
    owner_name: detail.orgCustomerName || row.orgCustomerName,
    province: detail.provinceName || null,
    domain: detail.parentProjectTypeName || row.parentProjectTypeName || null,
    industry: detail.projectTypeName || row.projectTypeName || null,
    methodology_id: methodology,
    methodology_version: detail.methodologyNum || null,
    technology_route: detail.technologiesMeasures || null,
    boundary_desc: detail.basicInformation || null,
    registry_project_no: detail.projectCode || null,
    start_operation_date: ymd(detail.commencementDate),
    owner_announced_estimate: numberOrNull(detail.expectYearNum),
    verified_amount: numberOrNull(detail.certifiedNum),
    registered_amount: type === '4' ? numberOrNull(detail.issuedAmount ?? detail.issuedVol) : null,
    official_url: detailUrl({ ...row, dataType: type }),
    source_snapshot_id: snapshotId,
    last_checked_at: now,
    last_checked_result: old && changed ? 'changed' : 'ok',
    evidence_level: 'official_registry',
    review_status: 'auto_checked',
  };
  if (!old) {
    run(`INSERT INTO public_project (id,name,owner_name,province,domain,industry,methodology_id,methodology_version,
      technology_route,boundary_desc,registry_project_no,start_operation_date,owner_announced_estimate,verified_amount,
      registered_amount,official_url,source_snapshot_id,last_checked_at,last_checked_result,evidence_level,review_status,
      stage_project_public,stage_project_registered,stage_reduction_public,stage_reduction_registered,stage_cancelled,
      current_stage,note,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id,values.name,values.owner_name,values.province,values.domain,values.industry,values.methodology_id,
      values.methodology_version,values.technology_route,values.boundary_desc,values.registry_project_no,
      values.start_operation_date,values.owner_announced_estimate,values.verified_amount,values.registered_amount,
      values.official_url,snapshotId,now,'ok','official_registry','auto_checked',flags.stage_project_public,
      flags.stage_project_registered,flags.stage_reduction_public,flags.stage_reduction_registered,flags.stage_cancelled,
      flags.current_stage,'官方公开接口自动读取；项目事实须以详情页及附件为准。',now,now]);
  } else {
    run(`UPDATE public_project SET name=?,owner_name=?,province=COALESCE(?,province),domain=COALESCE(?,domain),
      industry=COALESCE(?,industry),methodology_id=COALESCE(?,methodology_id),
      methodology_version=COALESCE(?,methodology_version),technology_route=COALESCE(?,technology_route),
      boundary_desc=COALESCE(?,boundary_desc),registry_project_no=COALESCE(?,registry_project_no),
      start_operation_date=COALESCE(?,start_operation_date),owner_announced_estimate=COALESCE(?,owner_announced_estimate),
      verified_amount=COALESCE(?,verified_amount),registered_amount=COALESCE(?,registered_amount),
      official_url=?,source_snapshot_id=?,last_checked_at=?,last_checked_result=?,evidence_level='official_registry',
      review_status=CASE WHEN review_status='confirmed' THEN review_status ELSE 'auto_checked' END,
      stage_project_public=MAX(stage_project_public,?),stage_project_registered=MAX(stage_project_registered,?),
      stage_reduction_public=MAX(stage_reduction_public,?),stage_reduction_registered=MAX(stage_reduction_registered,?),
      stage_cancelled=MAX(stage_cancelled,?),current_stage=?,updated_at=? WHERE id=?`,
      [values.name,values.owner_name,values.province,values.domain,values.industry,values.methodology_id,
      values.methodology_version,values.technology_route,values.boundary_desc,values.registry_project_no,
      values.start_operation_date,values.owner_announced_estimate,values.verified_amount,values.registered_amount,
      values.official_url,snapshotId,now,values.last_checked_result,flags.stage_project_public,flags.stage_project_registered,
      flags.stage_reduction_public,flags.stage_reduction_registered,flags.stage_cancelled,flags.current_stage,now,id]);
  }
  return id;
}
const STAGE_EVENTS=[
  ['stage_project_public','project_public'],
  ['stage_project_registered','project_registration'],
  ['stage_reduction_public','reduction_public'],
  ['stage_reduction_registered','reduction_registration'],
  ['stage_cancelled','cancellation'],
];
export function ensureRegistryEvents(projectId) {
  const p=get('SELECT * FROM public_project WHERE id=?',[projectId]);
  if(!p||!projectId.startsWith('REG-')) return 0;
  let added=0;
  for(const [flag,type] of STAGE_EVENTS) {
    if(!p[flag])continue;
    const exists=get('SELECT id FROM project_event WHERE public_project_id=? AND event_type=?',[projectId,type]);
    if(!exists) {
      const now=nowIso();
      run(`INSERT INTO project_event (id,public_project_id,event_type,official_url,source_snapshot_id,
        evidence_level,review_status,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [newId('PEV'),projectId,type,p.official_url,p.source_snapshot_id,'official_registry','auto_checked',
          '依据注册登记系统公开栏目阶段自动生成；具体日期与金额以官方详情及文件为准。',now,now]);
      added++;
    }
    run(`UPDATE data_reconciliation SET status='resolved',resolved_by='system:registry',resolved_at=?,
      resolution='官方公开栏目阶段已生成可追溯事件' WHERE dataset='project' AND check_kind='stage_without_event'
      AND object_id=? AND status='open'`,[nowIso(),`${projectId}::${flag}`]);
  }
  return added;
}
function saveFile(projectId, applyId, file, { archiveFiles, maxFileBytes }) {
  const existing = get('SELECT id,file_hash,local_path FROM evidence WHERE object_type=? AND object_id=? AND source_url=?',
    ['public_project',projectId,file.url]);
  if (existing?.file_hash && existing.local_path) return { status: 'unchanged' };
  return { status: 'new', existing };
}
async function archiveFile(projectId, applyId, file, opts) {
  const check = saveFile(projectId, applyId, file, opts);
  if (check.status === 'unchanged') return check;
  let hash = null, size = null, path = null, excerpt = null, note = null;
  if (opts.archiveFiles) {
    const attachmentHeaders={ referer: REGISTRY_PAGE };
    if (process.env.CCER_REGISTRY_COOKIE) attachmentHeaders.cookie=process.env.CCER_REGISTRY_COOKIE;
    const r = await fetchText(file.url, { allowedDomains: registryAllowedDomains(), headers: attachmentHeaders,
      rateLimitPerMin: 90, timeoutMs: 40000, retryMax: 1 });
    const isPdf=file.name.toLowerCase().endsWith('.pdf');
    const validContent=!isPdf || r.buf?.subarray(0,5).toString('ascii')==='%PDF-';
    if (r.ok && validContent && r.buf?.length <= opts.maxFileBytes) {
      hash = sha256(r.buf); size = r.buf.length;
      const dir = resolve(dirname(dbPath()),'registry-files',String(applyId));
      mkdirSync(dir,{recursive:true});
      const ext = file.name.toLowerCase().endsWith('.pdf') ? '.pdf' : '.bin';
      path = join(dir,`${hash}${ext}`);
      writeFileSync(path,r.buf);
      if (ext === '.pdf') {
        // 统一异步逐页解析（docs/36 第 5 条）：文本层 + 缺文字/乱码页 OCR；
        // 旧的同步 pdftotext（execFileSync + 管道）在受限环境下取不到输出，已弃用。
        try {
          const parsed = await parsePdfDocument({ filePath: path, sha256: hash, maxPages: 100 });
          if (parsed.text) {
            writeFileSync(`${path}.txt`, parsed.text, 'utf8');
            excerpt = parsed.text.slice(0, 500);
            note = `逐页解析：共 ${parsed.pages_total} 页，文本层 ${parsed.pages_text} 页 + OCR ${parsed.pages_ocr} 页，失败 ${parsed.pages_failed} 页 → ${parsed.status}`;
          } else {
            note = `PDF 无可提取文本（${parsed.error || parsed.note || '扫描件'}），需要 OCR`;
          }
        } catch (e) { note = `PDF 文本提取不可用或文件为扫描件：${e.message}`; }
      }
    } else note = !r.ok ? `附件下载失败：${r.error}` : !validContent
      ? '官方附件链接未返回有效 PDF（可能要求登录或文件暂不可取），仅保留来源链接'
      : `附件超过 ${opts.maxFileBytes} 字节上限`;
  }
  const now = nowIso();
  if (check.existing) run(`UPDATE evidence SET file_name=?,file_hash=?,file_type=?,file_size=?,local_path=?,
    excerpt=?,retention_note=?,uploaded_at=? WHERE id=?`,
    [file.name,hash,file.name.split('.').pop()?.toLowerCase()||null,size,path,excerpt,note,now,check.existing.id]);
  else run(`INSERT INTO evidence (id,object_type,object_id,file_name,file_hash,file_type,file_size,local_path,doc_type,
    excerpt,evidence_level,source_url,uploaded_by,uploaded_at,extraction,confidentiality,retention_note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [newId('EV'),'public_project',projectId,file.name,hash,file.name.split('.').pop()?.toLowerCase()||null,
      size,path,file.doc_type,excerpt,'official_registry',file.url,'system:registry',now,'import','internal',note]);
  return { status: path ? 'archived' : 'linked', note };
}
export function registryStatus() {
  const last = get('SELECT MAX(last_seen_at) AS at FROM registry_observation');
  const byType = all('SELECT data_type,COUNT(*) AS n FROM registry_observation GROUP BY data_type ORDER BY data_type');
  const docs = get('SELECT COUNT(*) AS n,SUM(CASE WHEN local_path IS NOT NULL THEN 1 ELSE 0 END) AS archived FROM evidence WHERE object_type=? AND uploaded_by=?',
    ['public_project','system:registry']);
  return { source: REGISTRY_PAGE, last_sync_at: last?.at || null, records: byType,
    projects: get("SELECT COUNT(*) AS n FROM public_project WHERE id LIKE 'REG-%'")?.n || 0,
    files_linked: docs?.n || 0, files_archived: docs?.archived || 0 };
}
/** 每日同步：全部栏目翻页；默认重读全部详情，避免列表不变但附件已更新。 */
export async function syncRegistry({ actor='system:registry', maxDetails=500, archiveFiles=!!process.env.CCER_REGISTRY_COOKIE,
  maxFilesPerProject=8, maxFileBytes=20_000_000, activeRefresh=true, onProgress=null } = {}) {
  const stats = { lists:0, listed:0, details:0, projects_new:0, projects_updated:0, files_archived:0, files_linked:0, errors:[],
    /* docs/36 第 8 条：0 行不是成功 —— 如实记录空栏目数 */ rows_zero_lists:0, empty_types:[] };
  for (const type of TYPES) {
    let page=1, totalPages=1;
    do {
      const {data,res} = await post(LIST(),{dataType:type,pageNumber:page,pageSize:100});
      const snapshot=recordSnapshot({url:`${LIST()}?dataType=${encodeURIComponent(type)}&page=${page}`,res,parser:'registry_list_v1',parseQuality:'good'});
      const rows=Array.isArray(data.dataInfo)?data.dataInfo:[];
      stats.lists++; stats.listed+=rows.length;
      if (!rows.length) { stats.rows_zero_lists+=1; if(!stats.empty_types.includes(type)) stats.empty_types.push(type); }
      totalPages=Math.min(Math.ceil(Number(data.total||0)/100)||1,100);
      for (const row of rows) {
        if (!/^\d+$/.test(String(row.applyId||''))) {stats.errors.push(`栏目 ${type} 存在缺失 applyId 的记录`);continue;}
        const id=`REG-${row.applyId}`, old=get('SELECT * FROM registry_observation WHERE apply_id=? AND data_type=?',[String(row.applyId),type]);
        const listHash=sha256(Buffer.from(JSON.stringify(row)));
        const shouldDetail=!old || old.list_hash!==listHash || activeRefresh;
        if (shouldDetail && stats.details < maxDetails) {
          try {
            const payload={applyId:row.applyId,ccerId:row.ccerId,certificationId:row.certificationId,
              dataType:type,projectInfoId:row.projectInfoId,applyStatus:row.applyStatus};
            const out=await post(DETAIL(),payload);
            const detail=out.data.dataInfo;
            if (!detail || typeof detail!=='object') throw new Error('项目详情为空');
            const snap=recordSnapshot({url:detailUrl({...row,dataType:type}),res:out.res,parser:'registry_detail_v1',parseQuality:'good'});
            const projectId=upsertProject(row,detail,type,snap.id,!old || old.detail_hash!==out.res.hash);
            ensureRegistryEvents(projectId);
            const files=parseFiles(detail).slice(0,Math.max(0,maxFilesPerProject));
            for (const file of files) {
              const r=await archiveFile(id,row.applyId,file,{archiveFiles,maxFileBytes});
              if (r.status==='archived') stats.files_archived++;
              if (r.status==='linked') stats.files_linked++;
            }
            const now=nowIso();
            run(`INSERT INTO registry_observation (apply_id,data_type,public_project_id,list_hash,detail_hash,status_name,
              source_snapshot_id,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?)
              ON CONFLICT(apply_id,data_type) DO UPDATE SET list_hash=excluded.list_hash,detail_hash=excluded.detail_hash,
              status_name=excluded.status_name,source_snapshot_id=excluded.source_snapshot_id,last_seen_at=excluded.last_seen_at`,
              [String(row.applyId),type,id,listHash,out.res.hash,row.statusName||null,snap.id,old?.first_seen_at||now,now]);
            stats.details++; if(old)stats.projects_updated++;else stats.projects_new++;
          } catch(e) { stats.errors.push(`${type}/${row.applyId}: ${e.message}`); }
        } else if(old) run('UPDATE registry_observation SET last_seen_at=?,source_snapshot_id=? WHERE apply_id=? AND data_type=?',
          [nowIso(),snapshot.id,String(row.applyId),type]);
        if(onProgress) onProgress(stats);
      }
      page++;
    } while(page<=totalPages);
  }
  for (const p of all("SELECT id FROM public_project WHERE id LIKE 'REG-%'")) ensureRegistryEvents(p.id);
  // 【docs/36 第 8 条】0 行不是成功：全部栏目都返回 0 行时必须保留 parse gap，
  // 且返回值 ok=false，让 ingestion_job 不能落到 success。
  if (stats.listed === 0) {
    stats.errors.push(`所有栏目均返回 0 行（空栏目：${stats.empty_types.join('、') || '无'}）：接口可能改版、返回体结构变化，或被风控拦截；保留 parse gap，不标记成功。`);
  }
  if (stats.details > 0 && stats.errors.length === 0) {
    run(`UPDATE data_gap SET status='mitigated',title='注册登记系统公开项目接口改版与覆盖核对',
      description='已接入公开页面站内列表与详情接口；须持续监控分页总数、字段变更和附件可用性。',
      severity='normal',updated_at=? WHERE gap_key='gap-registry-project-list'`,[nowIso()]);
    run(`UPDATE datasource_config SET url=?,parser='registry_public_list_v1',frequency='daily',enabled=1,paused=0,
      license_note='公开页面站内接口每日同步；异常进入复核；接口可能改版',updated_at=?
      WHERE name='全国 CCER 注册登记系统及信息平台'`,[REGISTRY_PAGE,nowIso()]);
  }
  if (stats.listed === 0) {
    const now = nowIso();
    const existing = get("SELECT id FROM data_gap WHERE gap_key='gap-registry-list-empty'");
    const title = '注册登记系统公开项目列表返回 0 行（parse gap）';
    const description =
      `本次同步实际调用官方列表接口 ${stats.lists} 次，全部返回 0 行（栏目：${stats.empty_types.join('、') || '无'}）。` +
      '0 行不等于「没有项目」：可能是接口改版、返回体字段变化、分页参数失效或风控拦截。' +
      '本轮不写入任何推测项目，也不把该任务标为成功。';
    const impact = '公开项目库本轮无新增/更新；项目覆盖情况以库内既有记录为准，缺口如实保留。';
    const manualPath = '核对官方公开栏目的分页返回结构后调整解析器；必要时用管理员导入通道补齐。';
    if (existing) {
      run('UPDATE data_gap SET title=?,description=?,impact=?,manual_path=?,severity=?,status=?,updated_at=? WHERE gap_key=?',
        [title, description, impact, manualPath, 'warning', 'open', now, 'gap-registry-list-empty']);
    } else {
      run(`INSERT INTO data_gap (id,dataset,gap_key,title,description,impact,manual_path,severity,status,detected_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [newId('GAP'), 'project', 'gap-registry-list-empty', title, description, impact, manualPath, 'warning', 'open', now, now]);
    }
  }
  audit({actor,actorRole:'system',action:'registry.sync',objectType:'registry',objectId:'daily',detail:stats});
  return {ok:stats.errors.length===0 && stats.listed>0, stats, status:registryStatus()};
}
