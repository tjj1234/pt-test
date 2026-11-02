"""Real worker JSONL contract with injected offline transport, no provider calls."""
import importlib.util,io,json,pathlib,socket,unittest
ROOT=pathlib.Path(__file__).resolve().parents[2]
def blocked(*args,**kwargs):raise AssertionError('NETWORK_FORBIDDEN')
socket.socket.connect=blocked
socket.socket.connect_ex=blocked
socket.create_connection=blocked
socket.getaddrinfo=blocked
spec=importlib.util.spec_from_file_location('worker',ROOT/'shell/media/ptvideo-worker.py')
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)
ID='12345678-1234-4123-8123-123456789012'
class WorkerTests(unittest.TestCase):
 def execute(self,kind='video',refused=None):
  request={'model':'fixture-model','kind':kind,'prompt':'fixture'}
  initial={'version':1,'type':'generate','requestId':ID,'apiKey':'PRIVATE_FIXTURE_KEY','baseUrl':'https://api.example.test','request':request}
  frames=[initial]+[{'version':1,'type':'ack','requestId':ID,'eventId':i,'ok':i!=refused} for i in range(1,4)]
  stdin=io.BytesIO(('\n'.join(json.dumps(x) for x in frames)+'\n').encode());stdout=io.StringIO();calls=[]
  def transport(method,endpoint,key,body=None,timeout=None):
   calls.append(method)
   if kind=='image':return {'data':[{'url':'https://cdn.example.test/result.png'}]}
   if method=='POST':return {'id':'task_fixture'}
   return {'status':'completed','url':'https://cdn.example.test/result.mp4'}
  worker.run(stdin,stdout,transport)
  output=[json.loads(x) for x in stdout.getvalue().splitlines()]
  self.assertNotIn('PRIVATE_FIXTURE_KEY',stdout.getvalue())
  return output,calls
 def test_video(self):
  out,calls=self.execute();self.assertEqual(calls,['POST','GET']);self.assertTrue(out[-1]['result']['ok']);self.assertEqual([x['event'] for x in out if x['type']=='event'],['before_submit','task_id','result'])
 def test_image(self):
  out,calls=self.execute('image');self.assertEqual(calls,['POST']);self.assertTrue(out[-1]['result']['ok'])
 def test_intent_refusal(self):
  out,calls=self.execute(refused=1);self.assertEqual(calls,[]);self.assertEqual(out[-1]['result']['error_code'],'BEFORE_SUBMIT_REJECTED')
 def test_id_refusal(self):
  out,calls=self.execute(refused=2);self.assertEqual(calls,['POST']);self.assertEqual(out[-1]['result']['task_id'],'task_fixture');self.assertEqual(out[-1]['result']['error_code'],'TASK_ID_WRITE_FAILED')
if __name__=='__main__':unittest.main()
