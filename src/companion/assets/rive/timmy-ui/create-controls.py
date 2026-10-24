from pathlib import Path
import shutil,xml.sax.saxutils as xml
p=Path(__file__).parent
# (H174: the operator's own copy line, which named a path of his computer, is replaced: the font is kept beside this file, with OFL.txt)
# shutil.copy2('<the Rive CLI samples folder>/integrated_titlebar/Montserrat.ttf', p/'Montserrat.ttf')
(p/'rive.yaml').write_text('name: timmy-ui\nlogs:\n  file: build/rive.log\n  problems: build/problems.log\n')
counter=10
FONT='0:1'
def ident():
 global counter
 counter+=1
 return '0:'+str(counter)
def rect(x,y,w,h,c,name='',radius=0,stroke=None,opacity=1):
 sid=ident();paint=f'<Fill><SolidColor colorValue="{c}"/></Fill>' if c else ''
 if stroke:paint+=f'<Stroke thickness="1"><SolidColor colorValue="{stroke}"/></Stroke>'
 return sid,f'<Shape x="{x}" y="{y}" opacity="{opacity}" name="{name}" id="{sid}"><Rectangle width="{w}" height="{h}" originX="0.5" originY="0.5" cornerRadiusTL="{radius}"/>{paint}</Shape>'
def text(x,y,value,size=14,color='FFF2EFE9',name=''):
 sid,sty=ident(),ident()
 return sid,f'<Text x="{x}" y="{y}" name="{name}" id="{sid}"><TextStylePaint fontSize="{size}" fontAssetId="{FONT}" familyName="Montserrat" styleName="Medium" id="{sty}"><TextStyleAxis tag="2003265652" axisValue="{550 if size>=19 else 450}"/><Fill><SolidColor colorValue="{color}"/></Fill></TextStylePaint><TextValueRun styleId="{sty}" text="{xml.escape(value, {chr(34):"&quot;"})}" name="{name or value}"/></Text>'
def circle(x,y,r,color='FFFFB000',width=2,trim=False):
 sid=ident();tid=ident()
 return sid,tid,f'<Shape x="{x}" y="{y}" id="{sid}"><Ellipse width="{r*2}" height="{r*2}" originX="0.5" originY="0.5"/><Stroke thickness="{width}" cap="round"><SolidColor colorValue="{color}"/>{f"<TrimPath start=\"0\" end=\"0.68\" id=\"{tid}\"/>" if trim else ""}</Stroke></Shape>'
def key(obj,prop,values,color=False):
 kind='KeyFrameColor' if color else 'KeyFrameDouble'
 return f'<KeyedObject objectId="{obj}"><KeyedProperty propertyKey="{prop}">'+''.join(f'<{kind} frame="{frame}" value="{value}" interpolationType="linear"/>' for frame,value in values)+'</KeyedProperty></KeyedObject>'
def group(children,name,opacity=0):
 gid=ident();return gid,f'<Node opacity="{opacity}" name="{name}" id="{gid}">'+''.join(children)+'</Node>'
def build(name,w,h,title,kind):
 art,style,sm=ident(),ident(),ident();state,hover,pressed,motion=ident(),ident(),ident(),ident()
 def transition(target,conditions):
  return ''.join(f'<StateTransition stateToId="{target}" duration="{duration}">{conditions}<TransitionBoolCondition inputId="{motion}"{op}/></StateTransition>' for duration,op in [(180,' opValue="notEqual"'),(0,'')])
 draw=[]
 if kind!='button':
  draw += [rect(w/2,h/2,w-2,h-2,'FF070707','Panel',18,'FF444444')[1],rect(w/2,55,w-50,1,'FF333333')[1],text(28,22,'TIMMY  /  '+title.upper(),12,'FF8E8E93')[1],text(w-156,24,'NATIVE RIVE UI',9,'FF8E8E93')[1]]
 else:draw.append(rect(w/2,h/2,w-2,h-2,'FF111111','ActionButton',12,'FF444444')[1])
 groups=[];ring=None;scan=None
 labels=['Ready when you are','Working on your idea','Your approval comes first','Stopped. You are in control.','Let’s try another route.'] if kind=='agent' else ['Choose your connection','Checking your connection','Review what you allow','Connection stopped','Could not connect']
 for i in range(5):
  children=[]
  if kind=='button':
   labelsbtn=['Connect provider','Checking…','Review access','Stopped','Try again']
   children.append(text(25,27,labelsbtn[i],14,'FFFFB000')[1]);children.append(text(w-38,26,'→' if i==0 else '…' if i==1 else '◇' if i==2 else '■' if i==3 else '×',17,'FFFFB000')[1])
  else:
   y=94 if kind=='agent' else 80
   if kind=='agent':
    children.append(text(28,y,labels[i],28)[1]);children.append(text(30,y+42,['Make room for the next thing you want to make.','A visible state, driven by the runtime.','Inspect the change before it becomes your result.','No more motion until you choose the next step.','Keep the error visible. Keep a useful next action.'][i],12,'FF8E8E93')[1])
   else:
    children.append(text(25,y,labels[i],19)[1]);children.append(text(26,y+32,'OpenRouter  ·  Ollama  ·  Cloudflare',11,'FF8E8E93')[1])
   cy=230 if kind=='agent' else 160;cx=w/2
   sid,tid,markup=circle(cx,cy,44 if kind=='agent' else 24,'FF333333',2);children.append(markup)
   if i==1:
    ring,_,markup=circle(cx,cy,44 if kind=='agent' else 24,'FFFFB000',4,True);children.append(markup)
    for offset in range(5):children.append(rect(cx-44+offset*22,cy+67 if kind=='agent' else cy+42,8,4+offset*5,'FFFFB000',radius=2)[1])
   elif i==2:
    children.append(f'<Shape x="{cx}" y="{cy}" rotation="0.785398"><Rectangle width="{30 if kind=="agent" else 16}" height="{30 if kind=="agent" else 16}" originX="0.5" originY="0.5"/><Stroke thickness="3"><SolidColor colorValue="FFFFB000"/></Stroke></Shape>')
   elif i==3:children.append(rect(cx,cy,24 if kind=='agent' else 14,24 if kind=='agent' else 14,'FF8E8E93',radius=3)[1])
   elif i==4:
    for angle in ['0.785398','-0.785398']:children.append(f'<Shape x="{cx}" y="{cy}" rotation="{angle}"><Rectangle width="{36 if kind=="agent" else 22}" height="3" originX="0.5" originY="0.5"/><Fill><SolidColor colorValue="FFFFB000"/></Fill></Shape>')
   else:
    children.append(rect(cx,cy-9,32 if kind=='agent' else 21,5,'FFFFB000',radius=1)[1]);children.append(rect(cx,cy+4,5,26 if kind=='agent' else 18,'FFFFB000',radius=1)[1])
  gid,gmarkup=group(list(reversed(children)),['Idle','Working','Approval','Stopped','Failed'][i],1 if i==0 else 0);groups.append(gid);draw.append(gmarkup)
 if kind!='button':
  by=h-42
  hit,markup=rect(w-108,by,160,40,'FFFFB000','Primary action',7)
  draw.append(markup);draw.append(text(w-172,by-7,'Inspect interaction',11,'FF000000')[1])
  draw.append(text(28,h-47,'PREVIEW  /  NOT A LIVE JOB',9,'FF8E8E93')[1])
 else:hit=ident();draw.append(f'<Shape x="{w/2}" y="{h/2}" id="{hit}" name="Button hit area"><Rectangle width="{w-4}" height="{h-4}" originX="0.5" originY="0.5" cornerRadiusTL="12"/><Fill><SolidColor colorValue="01000000"/></Fill></Shape>')
 hoverid,hovermarkup=rect(w/2,h/2,w-4,h-4,None,'Hover outline',16 if kind!='button' else 12,'FFFFB000',0)
 pressid,pressmarkup=rect(w/2,h/2,w-8,h-8,'22FFB000','Pressed wash',14 if kind!='button' else 10,opacity=0)
 draw.extend([hovermarkup,pressmarkup])
 animations=[];states=[]
 for i in range(5):
  aid=ident();stid=ident();states.append(stid)
  keys=''.join(key(g,18,[(0,1 if j==i else 0)]) for j,g in enumerate(groups))
  if i==1 and ring:keys+=key(ring,15,[(0,0),(120,6.2831853)])
  animations.append(f'<LinearAnimation name="{["Idle","Working","Approval","Stopped","Failed"][i]}" duration="120" fps="60" loopValue="loop" id="{aid}">{keys}</LinearAnimation>')
  states[i]=(stid,aid)
 lid=ident();machine=f'<StateMachine name="TimmyUI" id="{sm}"><StateMachineNumber name="State" value="0" id="{state}"/><StateMachineBool name="Hover" id="{hover}"/><StateMachineBool name="Pressed" id="{pressed}"/><StateMachineBool name="ReducedMotion" id="{motion}"/><StateMachineLayer name="Operation states" id="{lid}"><AnyState x="0" y="-160">'+''.join(transition(stid,f'<TransitionNumberCondition inputId="{state}" value="{i}"/>') for i,(stid,aid) in enumerate(states))+'</AnyState><ExitState x="1100" y="-160"/><EntryState x="0" y="0"><StateTransition stateToId="'+states[0][0]+'"/></EntryState>'+''.join(f'<AnimationState x="{180+i*220}" y="0" animationId="{aid}" reset="true" id="{stid}"/>' for i,(stid,aid) in enumerate(states))+'</StateMachineLayer>'
 for inputid,target,nm in [(hover,hoverid,'Hover'),(pressed,pressid,'Pressed')]:
  offa,ona,offs,ons=ident(),ident(),ident(),ident()
  animations.append(f'<LinearAnimation name="{nm} off" duration="12" id="{offa}">{key(target,18,[(0,0)])}</LinearAnimation>')
  animations.append(f'<LinearAnimation name="{nm} on" duration="12" id="{ona}">{key(target,18,[(0,1)])}</LinearAnimation>')
  machine+=f'<StateMachineLayer name="{nm}"><AnyState x="0" y="-160"/><ExitState x="600" y="-160"/><EntryState x="0" y="0"><StateTransition stateToId="{offs}"/></EntryState><AnimationState x="180" y="0" animationId="{offa}" id="{offs}"><StateTransition stateToId="{ons}" duration="120"><TransitionBoolCondition inputId="{inputid}"/></StateTransition></AnimationState><AnimationState x="400" y="0" animationId="{ona}" id="{ons}"><StateTransition stateToId="{offs}" duration="120"><TransitionBoolCondition inputId="{inputid}" opValue="notEqual"/></StateTransition></AnimationState></StateMachineLayer>'
 for event,inputid,val in [('enter',hover,'true'),('exit',hover,'false'),('down',pressed,'true'),('up',pressed,'false')]:
  machine+=f'<StateMachineListenerSingle name="Button {event}" targetId="{hit}" listenerTypeValue="{event}"><ListenerBoolChange inputId="{inputid}" value="{val}"/></StateMachineListenerSingle>'
 machine+=f'<StateMachineListenerSingle name="Inspect click" targetId="{hit}" listenerTypeValue="click"><ListenerNumberChange inputId="{state}" value="1"/></StateMachineListenerSingle></StateMachine>'
 return f'<Artboard name="{name}" id="{art}" width="{w}" height="{h}" styleId="{style}" defaultStateMachineId="{sm}"><LayoutComponentStyle id="{style}"/>'+''.join(reversed(draw))+machine+''.join(animations)+'</Artboard>'
scene='<Rive version="1" kind="fragment">'+build('AgentConsole',640,380,'Agent console','agent')+build('ProviderCard',400,260,'Providers','provider')+build('ActionButton',240,72,'Action','button')+f'<FontAsset file="Montserrat.ttf" name="Montserrat" id="{FONT}"/></Rive>'
(p/'scene.rml').write_text(scene)
print('authored',p/'scene.rml')
