#!/usr/bin/env python3
"""Main-review regression over the vendored R3 engine; no sockets or credentials."""
import importlib.util,json,socket,unittest
from pathlib import Path

def blocked(*args,**kwargs): raise RuntimeError('OFFLINE')
socket.socket.connect=blocked;socket.socket.connect_ex=blocked
socket.create_connection=blocked;socket.getaddrinfo=blocked
ENGINE=Path(__file__).resolve().parents[2]/'shell/media/vendor/powertokens_video/pt_video.py'
class MainReview(unittest.TestCase):
    def setUp(self):
        spec=importlib.util.spec_from_file_location('main_engine',ENGINE)
        self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)
        self.key='offline-key';self.posts=0;self.gets=0
    def image(self): return self.m.ProductRequest(model='image-01',kind='image',prompt='fixture')
    def video(self): return self.m.ProductRequest(model='wan3.0-video',kind='video',prompt='fixture')
    def call(self,request,response,hooks=None,token=None):
        def transport(method,*args):
            if method=='POST':
                self.posts+=1
                return response if request.kind=='image' else {'id':'fixture-task'}
            self.gets+=1;return response
        return self.m.generate_for_product(request,api_key=self.key,hooks=hooks,_transport=transport,_cancel=token)
    def no_private(self,result): self.assertNotIn('PRIVATE_SENTINEL',json.dumps(result.to_dict()))
    def test_failed_image_error_is_not_echoed(self):
        result=self.call(self.image(),{'status':'FAILED','error':'PRIVATE_SENTINEL','data':[{'url':'https://cdn.invalid/error.png'}]})
        self.assertFalse(result.ok);self.assertEqual(result.status,'failed');self.no_private(result)
    def test_failed_image_item_cannot_become_success(self):
        result=self.call(self.image(),{'data':[{'status':'failed','error':'PRIVATE_SENTINEL','url':'https://cdn.invalid/error.png'}]})
        self.assertFalse(result.ok);self.no_private(result)
    def test_completed_poll_with_top_error_is_failed(self):
        result=self.call(self.video(),{'status':'completed','error':'PRIVATE_SENTINEL','metadata':{'url':'https://cdn.invalid/error.mp4'}})
        self.assertFalse(result.ok);self.assertEqual(result.task_id,'fixture-task');self.no_private(result)
    def test_completed_poll_with_metadata_error_is_failed(self):
        result=self.call(self.video(),{'status':'completed','metadata':{'url':'https://cdn.invalid/error.mp4','error':'PRIVATE_SENTINEL'}})
        self.assertEqual(result.error_code,'REMOTE_TASK_FAILED');self.no_private(result)
    def test_remote_error_cannot_spoof_local_control_reason(self):
        for marker in ['POLL_CANCELLED','POLL_TIMEOUT']:
            result=self.call(self.video(),{'status':'failed','error':marker+' PRIVATE_SENTINEL'})
            self.assertEqual(result.error_code,'REMOTE_TASK_FAILED');self.assertEqual(result.status,'failed');self.no_private(result)
    def test_query_auth_error_preserves_submitted_task_without_retry_advice(self):
        def transport(method,*args):
            if method=='POST':return {'id':'fixture-task'}
            raise self.m.ApiError(403,'PRIVATE_SENTINEL')
        result=self.m.generate_for_product(self.video(),api_key=self.key,_transport=transport)
        self.assertEqual(result.error_code,'POLL_QUERY_FAILED');self.assertEqual(result.task_id,'fixture-task');self.no_private(result)
        self.assertIn('不自动重提',result.error_hint)
    def test_malformed_task_id_is_submission_unknown_and_never_polled(self):
        for identifier in [True,123,'../private','id?token=private','id\n','x'*257,self.key]:
            calls=[]
            def transport(method,*args):calls.append(method);return {'id':identifier}
            result=self.m.generate_for_product(self.video(),api_key=self.key,_transport=transport)
            self.assertEqual(result.error_code,'SUBMISSION_OUTCOME_UNKNOWN');self.assertIsNone(result.task_id);self.assertEqual(calls,['POST'])
    def test_result_url_port_host_and_empty_userinfo_are_rejected(self):
        for url in ['https://cdn.invalid:bad/a','https://cdn.invalid:99999/a','https://@cdn.invalid/a','https://bad host/a','https://cdn.invalid:0/a','https://cdn.invalid:/a','file:///a']:
            self.assertFalse(self.m._is_safe_result_url(url),url)
        self.assertTrue(self.m._is_safe_result_url('https://cdn.invalid/a%20b?sig=abc+123'))
    def test_cancelled_image_save_failure_is_not_swallowed(self):
        token=self.m.CancellationToken()
        class Hooks(self.m.ProductHooks):
            def on_result(self,result):raise RuntimeError('PRIVATE_SENTINEL')
        def transport(*args):token.cancel();return {'data':[{'url':'https://cdn.invalid/result.png'}]}
        result=self.m.generate_for_product(self.image(),api_key=self.key,_cancel=token,_transport=transport,hooks=Hooks())
        self.assertFalse(result.ok);self.assertEqual(result.status,'completed_local_save_failed');self.assertEqual(result.result_urls,['https://cdn.invalid/result.png']);self.no_private(result)
    def test_cancelled_video_save_failure_is_not_swallowed(self):
        token=self.m.CancellationToken()
        def poll(*args,**kwargs):token.cancel();return {'status':'completed','metadata':{'url':'https://cdn.invalid/result.mp4'}}
        self.m.poll_task=poll
        class Hooks(self.m.ProductHooks):
            def on_result(self,result):raise RuntimeError('PRIVATE_SENTINEL')
        result=self.m.generate_for_product(self.video(),api_key=self.key,_cancel=token,_transport=lambda *args:{'id':'fixture-task'},hooks=Hooks())
        self.assertEqual(result.status,'completed_local_save_failed');self.assertEqual(result.task_id,'fixture-task');self.no_private(result)
    def test_actual_transport_uses_deadline_and_rejects_late_body(self):
        clock=[0]
        class Response:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self,n):clock[0]=20;return b'{"data":[]}'
        class Opener:
            def open(self,*args,**kwargs):return Response()
        self.m._api_opener=Opener()
        request=self.image();request.submit_timeout=10
        result=self.m.generate_for_product(request,api_key=self.key,_clock=lambda:clock[0])
        self.assertEqual(result.error_code,'SUBMISSION_OUTCOME_UNKNOWN')
    def test_chunk_reader_rejects_before_read_and_limits_requested_bytes(self):
        calls=[]
        class Stream:
            def read(self,n):calls.append(n);return b'x'*n
        with self.assertRaises(self.m.ApiError):self.m._read_limited(Stream(),4,clock=lambda:0,deadline=0)
        self.assertEqual(calls,[])
        with self.assertRaises(self.m.ApiError):self.m._read_limited(Stream(),4)
        self.assertEqual(calls,[5])
    def test_signed_agreement_text_is_not_unsigned_evidence(self):
        code,_=self.m.classify_error(self.m.ApiError(400,'asset library user agreement already signed; content rejected'))
        self.assertEqual(code,'MEDIA_REJECTED')
        code,_=self.m.classify_error(self.m.ApiError(400,'asset library design rejected'))
        self.assertEqual(code,'MEDIA_REJECTED')
    def test_unknown_image_status_cannot_become_completed(self):
        for status in [['completed'],123,'queued']:
            result=self.call(self.image(),{'status':status,'data':[{'url':'https://cdn.invalid/result.png'}]})
            self.assertFalse(result.ok);self.assertEqual(result.status,'submission_unknown')
    def test_returned_key_in_asset_url_is_rejected(self):
        result=self.call(self.image(),{'data':[{'url':'https://cdn.invalid/result.png?key='+self.key}]})
        self.assertFalse(result.ok);self.assertEqual(result.result_urls,[])
if __name__=='__main__':unittest.main()
