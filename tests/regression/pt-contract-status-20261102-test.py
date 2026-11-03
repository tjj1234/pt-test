"""PT A.04/A.11 contract checks; no network, credentials or provider charges."""
import importlib.util, unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
class Contracts(unittest.TestCase):
 def engines(self):
  for name in ('pt_video.py','pt_video_product.py'):
   spec=importlib.util.spec_from_file_location('pt_contract',ROOT/'shell/media/vendor/powertokens_video'/name)
   module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);yield module
 def test_seedance_wire_seconds_is_decimal_string(self):
  for engine in self.engines():
   for duration in (2,5,30):
    body=engine.build_video_payload('seedance-fixture',duration,'720p','16:9',prompt='fixture',is_seedance=True)
    self.assertEqual(body['prompt'],'fixture');self.assertFalse(any(item.get('type')=='text' for item in body['media']));self.assertEqual(body['seconds'],str(duration));self.assertIsInstance(body['seconds'],str)
 def test_status_has_priority_over_conflicting_body(self):
  for engine in self.engines():
   for status,code in ((401,'KEY_INVALID'),(402,'QUOTA_INSUFFICIENT'),(403,'UPSTREAM_FORBIDDEN')):
    for message in ('','balance insufficient invalid token','asset library agreement required'):
     self.assertEqual(engine.classify_error(engine.ApiError(status,message))[0],code)
 def test_live_403_never_misclassifies_body_as_key_or_balance(self):
  for engine in self.engines():
   for message,code in (('','UPSTREAM_FORBIDDEN'),('insufficient balance','UPSTREAM_FORBIDDEN'),('invalid token','UPSTREAM_FORBIDDEN'),('no permission','UPSTREAM_FORBIDDEN')):
    self.assertEqual(engine.classify_error(engine.ApiError(403,message))[0],code)
 def test_poll_denial_never_retries_or_resubmits(self):
  for engine in self.engines():
   for status in (401,402,403):
    calls=[]
    def transport(method,*args):
     calls.append(method);raise engine.ApiError(status,'private fixture')
    with self.assertRaises(engine.ApiError):engine.poll_task('fixture-key','known-task',_transport=transport,_sleep=lambda *_:self.fail('must not retry'))
    self.assertEqual(calls,['GET'])
if __name__=='__main__':unittest.main()
