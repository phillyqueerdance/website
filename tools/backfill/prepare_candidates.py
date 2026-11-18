import collections,datetime as dt,hashlib,json,pathlib,re,unicodedata,sys
from zoneinfo import ZoneInfo
from functools import lru_cache
import openpyxl
root=pathlib.Path(sys.argv[1]).resolve() if len(sys.argv)>1 else pathlib.Path(__file__).parent
posts=json.loads((root/'all-posts.json').read_text())
assets=json.loads((root/'media-manifest.json').read_text())
ocr={r['key']:r.get('text','') for r in (json.loads(line) for line in (root/'ocr.jsonl').read_text().splitlines())}
seen=json.loads((root/'visual-inspections.json').read_text()) if (root/'visual-inspections.json').exists() else {}
events=[]
for file in sorted(root.glob('archive-2025-*.json')):events+=json.loads(file.read_text()).get('events',[])
artists=json.loads((root/'public-artists.json').read_text())['artists']
headers=json.loads((root/'intake-headers.json').read_text())
@lru_cache(maxsize=8192)
def norm(s):return re.sub(r'[^a-z0-9]+',' ',unicodedata.normalize('NFKD',str(s)).encode('ascii','ignore').decode().lower()).strip()
def has(text,term):return bool(term and re.search(r'(?<!\w)'+re.escape(norm(term))+r'(?!\w)',norm(text)))
venue_names={e['venueId']:e.get('venue','') for e in events if e.get('venueId')}
venue_aliases={id:[name] for id,name in venue_names.items()}
shorts={'Dolphin':['the dolphin','dolphin tavern','dolphinphilly'], 'Franky':['b west','bwest','franky bradleys','franky bradley'], '700':['the700','the 700','700 club'], 'Margoli':['margolis','margoli s'], 'Dahlak':['dahlak'], 'Say No More':['say no more','saynomore'], 'Strangelove':['strangeloves','strangelove s'], 'WKDU':['wkdu'], 'Kung Fu':['kung fu necktie','kungfunecktie'], 'Silk City':['silkcitydiner','silk city']}
for name,aliases in shorts.items():
 for id,full in venue_names.items():
  if norm(name) in norm(full):venue_aliases[id]+=aliases
artist_aliases={a['id']:[a['name'],a.get('instagram','').rstrip('/').rsplit('/',1)[-1]] for a in artists}
for id,terms in [('KUHREN-001',['poetik selektions','poetik selections','poetik selektions','poetikselections']),('CHIARA-001',['iiinfinite','genderaffirmingbob']),('FRSTNE-001',['firestone','like.the.tires'])]:artist_aliases.setdefault(id,[]).extend(terms)
by_date=collections.defaultdict(list)
for e in events:by_date[e['start'][:10]].append(e)
by_post=collections.defaultdict(list)
for a in assets:by_post[str(a['post'])].append(a)
months=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
month_pattern=r'(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
def dates(text,posted):
 text=text.lower();found={};global_years=set(re.findall(r'\b20(?:24|25|26|27)\b',text))
 def add(m,d,year,basis):
  try:
   y=int(year) if year else int(next(iter(global_years))) if len(global_years)==1 else posted.year
   if y<100:y+=2000
   if not year and not global_years:
    if m-posted.month>8:y-=1
    elif posted.month-m>8:y+=1
   value=dt.date(y,m,d).isoformat()
   if 2024<=y<=2027:found[value]=basis if year else basis+'; year from post/document context'
  except (ValueError,OverflowError):pass
 for match in re.finditer(r'(?<![\d$])([01]?\d)\s*[/.-]\s*([0-3]?\d)(?:\s*[/.-]\s*(20\d{2}|\d{2}))?(?!\d)',text):
  if re.match(r'\s*(?:am|pm)\b',text[match.end():]):continue
  add(int(match[1]),int(match[2]),match[3],'Numeric date in source')
 for match in re.finditer(month_pattern+r'\.?\s*(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(20\d{2}))?',text):add(months.index(match[1][:3])+1,int(match[2]),match[3],'Named date in source')
 for match in re.finditer(r'\b(\d{1,2})(?:st|nd|rd|th)?\s+'+month_pattern+r'(?:\s*,?\s*(20\d{2}))?',text):add(months.index(match[2][:3])+1,int(match[1]),match[3],'Named date in source')
 if re.search(r'\b(?:nye|new year[’\']?s? eve)\b',text) and (posted.month>=10 or posted.month==1):
  y=posted.year if posted.month>=10 else posted.year-1
  found={k:v for k,v in found.items() if not k.endswith('-12-31')}
  found[f'{y}-12-31']='New Year’s Eve date from announcement/recap context; verify the year against the source'
 return found
def times(text):
 t=re.sub(r'\s+',' ',text.lower()).replace('–','-').replace('—','-')
 for m in re.finditer(r'\b(\d{1,2})(?::([0-5]\d))?\s*([ap])?\.?m?\.?\s*(?:-|to|until|til)\s*(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?m\b',t):
  h1,h2=int(m[1]),int(m[4]);period1=m[3] or ('p' if m[6]=='a' and h1>=5 else m[6]);period2=m[6]
  if not(1<=h1<=12 and 1<=h2<=12):continue
  a=(h1%12)+(12 if period1=='p' else 0);b=(h2%12)+(12 if period2=='p' else 0)
  return f'{a:02}:{int(m[2] or 0):02}',f'{b:02}:{int(m[5] or 0):02}','Time range read from source; verify against selected flyer'
 return '','','Time boundaries not extracted; existing archive times are preserved unless selected'
def event_score(e,text,venue_ids,mentioned):
 score=0;reasons=[]
 if e.get('venueId') in venue_ids:score+=45;reasons.append('Venue name in source')
 if has(text,e['title']):score+=40;reasons.append('Archive title also appears in source')
 overlap=set(e.get('artistIds',[]))&set(mentioned)
 if overlap:score+=min(30,len(overlap)*10);reasons.append(str(len(overlap))+' artist names in source (roles need review)')
 if e.get('venueId') not in venue_ids and venue_ids:score-=25
 return score,reasons
def flyer_score(a,date):
 t=ocr.get(a['key'],'');s=len(re.findall(r'\w+',t))
 s=min(s,100)+20*bool(re.search(r'\b(?:dj|djs|dolphin|barbary|party|polari|700|margoli|dahlak|dance|pentridge)\b',t,re.I))
 if 'ra pick' in norm(t):s-=100
 if date:
  parsed=dates(t,dt.date.fromisoformat(a['date']));s+=80*(date in parsed)
 return s
def looks_like_flyer(a,date):
 t=ocr.get(a['key'],'');plain=norm(t)
 if len(t.split())<4 or any(s in plain for s in ['ra pick','accepting dj bookings','bookings open','behind this track','w x p n','community agreements','additional information','open decks info','room information']):return False
 dated=dates(t,dt.date.fromisoformat(a['date']))
 timed=bool(re.search(r'\b\d{1,2}\s*(?:pm|am|p m|a m)\b',t,re.I))
 event=bool(re.search(r'\b(?:dj|djs|party|dolphin|barbary|polari|700|pentridge|margoli|dahlak|tickets|doors|house|club|b2b|worship|levee|slip|dance|lineup|secret location|music by|sounds by|festival|rave)\b',t,re.I))
 return event and (date in dated if date else bool(dated) or timed)

groups={};leads=0;non_event=0
for p in posts:
 pk=str(p['pk']);postdate=dt.datetime.fromtimestamp(p['taken_at'],ZoneInfo('America/New_York')).date()
 if not dt.date(2024,12,1)<=postdate<dt.date(2026,2,1):continue
 media=by_post.get(pk,[]);caption=(p.get('caption') or {}).get('text','')
 texts=[caption]+[ocr.get(a['key'],'') for a in media];text='\n'.join(texts)
 all_dates=dates(text,postdate);extracted={k:v for k,v in all_dates.items() if k.startswith('2025-')}
 if all_dates and not extracted:continue
 if not extracted and re.search(r'\btonight\b',caption,re.I) and postdate.year==2025:extracted={postdate.isoformat():'Caption says tonight; date inferred from posting date and needs review'}
 eventlike=bool(re.search(r'\b(?:dj|djs|dance|dancing|party|lineup|tickets|doors|b2b|sets?|tonight|polari|levee|club|gig|show|rave|presents|disco|house|sapphic|pride)\b',text,re.I))
 if not eventlike:non_event+=1;continue
 if len(extracted)>16:extracted={};date_note='Many dates in a schedule; split the source manually before applying changes'
 if not extracted and (postdate.year!=2025 or set(re.findall(r'\b20(?:24|25|26|27)\b',text))=={'2026'}):continue
 if not extracted and not re.search(r'\b(?:tonight|tomorrow|tickets|doors|lineup|playing|spinning|join us|come through|come thru|catch me|last night|last weekend|this friday|this saturday|this sunday|set at|sets at)\b',text,re.I):continue
 if not extracted:extracted={'':'Event-like post without a securely extracted 2025 date; retain as a lead'}
 mentioned=[id for id,aliases in artist_aliases.items() if any(len(norm(a))>3 and has(text,a) for a in aliases)]
 venue_ids=[id for id,aliases in venue_aliases.items() if any(has(text,a) for a in aliases)]
 for date,basis in extracted.items():
  candidates=[]
  for e in by_date.get(date,[]):
   score,reasons=event_score(e,text,venue_ids,mentioned)
   if score>=40:candidates.append((score,e,reasons))
  candidates.sort(key=lambda v:-v[0])
  primary=candidates[0] if candidates and (len(candidates)==1 or candidates[0][0]-candidates[1][0]>=15) else None
  if primary and primary[1].get('venueId') in ['NOTO-001','AVE-001']:continue
  if not primary and re.search(r'\b(?:noto|the ave live)\b',text,re.I) and len(venue_ids)<=1:continue
  key='archive:'+primary[1]['eventId'] if primary else 'source:'+pk+(':'+date.replace('-','') if date else ':undated')
  ranked=sorted(media,key=lambda a:-flyer_score(a,date));selected=next((a for a in ranked if looks_like_flyer(a,date)),None)
  values={h:'' for h in headers};values['Timezone']='America/New_York';values['Review']='Hold'
  title=primary[1]['title'] if primary else ''
  if not title:
   lines=[re.sub(r'\s+',' ',line).strip() for line in (ocr.get(selected['key'],'') if selected else caption).splitlines() if len(line.strip())>3]
   title=next((line[:180] for line in lines if re.search(r'party|polari|levee|bug bop|sweet thang|pample|worship|night|feels|bent|sapphic|abbarama|disco|house',line,re.I)), 'Event lead — '+p['scraped_username'])
  start,end,time_note=times(ocr.get(selected['key'],'') if selected else text)
  venue=primary[1].get('venueId','') if primary and primary[1].get('venueId') in venue_ids else venue_ids[0] if len(venue_ids)==1 else ''
  values.update({'Title (internal)':title,'StartDate':date,'StartTime':start,'EndTime':end,'VenueID':venue,'Location':venue_names.get(venue,''),'Instagram_URL':p['post_url'], 'RawFlyerURL':selected['url'] if selected else '', 'ExplicitQueer (Yes/No)':'Yes' if re.search(r'\b(?:queer|sapphic|qtpoc|trans.centered|trans.only)\b',text,re.I) else ''})
  if date and end and start:values['EndDate']=(dt.date.fromisoformat(date)+dt.timedelta(days=end<=start)).isoformat()
  # Names seen in source evidence are proposed for review, never approved by default.
  values['Lineup_Raw']=', '.join(next((alias for alias in artist_aliases[id] if len(norm(alias))>3 and has(text,alias)),id) for id in mentioned)
  notes=[basis,time_note,'Verify the lineup roles, venue and year. Source names may include hosts or other dates.']
  if primary:notes.append('Title is the current archive label used to identify the proposed match; it is not newly written copy.')
  if len(venue_ids)>1:notes.append('Several venue names occur in this post; confirm which applies to this event.')
  values['Review_notes']=' '.join(notes)
  inspected=[a['id'] for a in media if a['key'] in seen]
  visual={'status':'inspected' if selected and selected['key'] in seen else 'source inspected; no flyer selected' if not selected and inspected else 'pending','mediaIds':[selected['id']] if selected else [],'inspectedMediaIds':inspected,'notes':'Selected image was visually inspected; unresolved facts still require approval.' if selected and selected['key'] in seen else 'No flyer selected. The source may still help identify a past event.' if not selected else 'Text-assisted proposal; selected image still needs visual inspection.'}
  evidence={'dateBasis':basis,'notes':values['Review_notes'],'mediaKeys':[a['key'] for a in media],'suggestedMatches':[{'eventId':e['eventId'],'score':score,'reasons':reasons} for score,e,reasons in candidates[:5]]}
  if key in groups:
   g=groups[key]
   if 'ig:'+pk not in g['postKeys']:g['postKeys'].append('ig:'+pk)
   g['evidence']['mediaKeys']=list(dict.fromkeys(g['evidence']['mediaKeys']+evidence['mediaKeys']))
   if visual['status']=='inspected' and g['visual']['status']!='inspected':g['visual']=visual;g['fields']['RawFlyerURL']=values['RawFlyerURL']
  else:groups[key]={'key':key,'postKeys':['ig:'+pk],'fields':values,'evidence':evidence,'visual':visual}
requested=[('hopifer','hopifer'),('like.the.tires','like.the.tires'),('djflakka','kennieflakka'),('lorboooo','lorboooo'),('iiinfinite','genderaffirmingbob'),('americaluvsme','americaluvsme'),('kuhrentheselector','kuhrentheselector'),('dj jamz','djjvmz'),('the dolphin','dolphinphilly'),('doll.redacted','doll.redacted')]
accounts=[]
for label,account in requested:
 selected=[p for p in posts if p['scraped_username']==account];d=[dt.datetime.fromtimestamp(p['taken_at'],ZoneInfo('America/New_York')).date().isoformat() for p in selected]
 oldest=min(d) if d else '';num=sum(v.startswith('2025') for v in d)
 note='Reached posts before January 2025; deleted, archived or private posts remain unavailable.' if oldest and oldest<'2025-01-01' else 'No posts from 2025 returned; historical public posts may be unavailable.' if not num else 'Earliest returned post is inside 2025; earlier months are not represented in the returned feed.'
 accounts.append({'requested':label,'account':account,'posts':len(selected),'posts2025':num,'oldest':oldest,'note':note})
candidates=sorted(groups.values(),key=lambda x:(not x['key'].startswith('archive:'),x['fields']['StartDate'] or '9999',x['key']))
coverage={'eventYear':2025,'runIds':['khmqa6WCevdy26rge','gahNcq0pEaTSmhkol'],'datasetIds':['F4cK1IfspUyifrscq','ldgZhFdRURc02uCVd'],'accounts':accounts,'posts':len(posts),'posts2025':sum(a['posts2025'] for a in accounts),'downloadedImages':len(assets),'notes':['Event date defines scope; Instagram posting date is separate.','All raw scraper records retained. Media pass covers posts December 1, 2024 through January 31, 2026.','Candidate matching uses public archive snapshots for preparation; Admin rechecks the current source sheets with shared alias rules.','Dates and names extracted from text remain proposals, with uncertainty shown.','Descriptions intentionally blank until selected for updating.']}
asset_metadata={'ig:'+str(a['post'])+':'+a['id']:{'sha256':a['sha256'],'file':a['path']} for a in assets if a.get('sha256')}
bundle={'assetMetadata':asset_metadata,'schema':'qdp-backfill-v1','runId':'qdp-2025-pilot-20261118','intakeHeaders':headers,'coverage':coverage,'posts':posts,'candidates':candidates}
(root/'QDP_2025_Backfill_Review.json').write_text(json.dumps(bundle,ensure_ascii=False))
(root/'coverage.json').write_text(json.dumps(coverage,indent=2))
import csv
with (root/'QDP_2025_Backfill_43_Columns.csv').open('w',newline='') as file:
 writer=csv.DictWriter(file,fieldnames=headers);writer.writeheader();writer.writerows(c['fields'] for c in candidates)
print({'posts':len(posts),'candidates':len(candidates),'proposedExisting':sum(c['key'].startswith('archive:') for c in candidates),'otherLeads':sum(not c['key'].startswith('archive:') for c in candidates),'visuallyInspectedSelections':sum(c['visual']['status']=='inspected' for c in candidates),'nonEventPosts':non_event},flush=True)
