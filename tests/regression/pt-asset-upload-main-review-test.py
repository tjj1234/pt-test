"""Offline main-review overlay plus unchanged Gemini assertions; no vendor edits."""
import importlib.util
import json
import pathlib
import shutil
import subprocess
import sys
import unittest
sys.dont_write_bytecode=True

root=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('upload_candidate_tests',root/'tests/regression/pt-asset-upload-product-candidate-test.py')
candidate=importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)
temp=pathlib.Path(candidate._TEMP_DIR)
subprocess.run(['git','apply','--check',str(root/'docs/refactor/candidates/pt-asset-upload-main-review-20261029.patch')],cwd=temp,check=True,capture_output=True)
subprocess.run(['patch','--dry-run','-p1','-i',str(root/'docs/refactor/candidates/pt-asset-upload-main-review-20261029.patch')],cwd=temp,check=True,capture_output=True)
subprocess.run(['patch','-p1','-i',str(root/'docs/refactor/candidates/pt-asset-upload-main-review-20261029.patch')],cwd=temp,check=True,capture_output=True)
spec=importlib.util.spec_from_file_location('upload_reviewed_engine',temp/'pt_video.py')
engine=importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)
candidate.pt_video=engine
spec=importlib.util.spec_from_file_location('generation_regression',root/'tests/regression/ptvideo-main-engine-test.py')
generation=importlib.util.module_from_spec(spec)
spec.loader.exec_module(generation)
generation.ENGINE=temp/'pt_video.py'

class MainReview(unittest.TestCase):
    def invoke(self,post=None,get=None,**options):
        calls=[]
        def transport(req,timeout):
            calls.append(req.get_method())
            data=post if req.get_method()=='POST' else get
            return candidate.FakeHTTPResponse(json.dumps(data).encode())
        result=engine.upload_asset_for_product(b'fixture',key='offline-key',transport=transport,**options)
        return result,calls

    def test_nonfinite_deadlines_zero_post(self):
        for timeout in (float('nan'),float('inf'),float('-inf')):
            result,calls=self.invoke(poll_timeout=timeout)
            self.assertEqual(calls,[])
            self.assertEqual(result['error_code'],'INVALID_TIMEOUT')

    def test_get_requires_explicit_success_code(self):
        for code in (None,True,'200',{},['PRIVATE_SENTINEL']):
            result,calls=self.invoke({'code':200,'data':{'task_id':'task'}},{'code':code,'data':{'asset_id':'asset'}})
            self.assertFalse(result['ok'])
            self.assertEqual(calls,['POST','GET'])
            self.assertNotIn('PRIVATE_SENTINEL',json.dumps(result))

    def test_post_code_never_echoed(self):
        for code in ('PRIVATE_SENTINEL',{'PRIVATE_SENTINEL':'value'},['PRIVATE_SENTINEL']):
            result,calls=self.invoke({'code':code})
            self.assertFalse(result['ok'])
            self.assertNotIn('PRIVATE_SENTINEL',json.dumps(result))
            self.assertEqual(calls,['POST'])
            self.assertEqual(result['outcome'],'unknown_submission')

    def test_ambiguous_post_code_preserves_unknown(self):
        for code in (None,True,500,408,429):
            result,calls=self.invoke({'code':code})
            self.assertEqual(result['outcome'],'unknown_submission')
            self.assertEqual(calls,['POST'])

    def test_content_snapshot_precedes_hooks(self):
        content=bytearray(b'fixture')
        bodies=[]
        def transport(req,timeout):
            bodies.append(req.data)
            return candidate.FakeHTTPResponse(b'{"code":400}')
        result=engine.upload_asset_for_product(content,key='offline-key',hooks={'before_submit':lambda _:content.__setitem__(slice(None),b'changed')},transport=transport)
        self.assertIn(b'fixture',bodies[0])
        self.assertNotIn(b'changed',bodies[0])
        self.assertEqual(result['byte_count'],7)

    def test_product_cannot_enable_cli_group(self):
        for field in ('group_name','_group_name'):
            result,calls=self.invoke(**{field:'hidden-group'})
            self.assertEqual(calls,[])
            self.assertEqual(result['error_code'],'INVALID_ARGUMENTS')

    def test_cli_group_uses_shared_core(self):
        original=engine._upload_asset_shared
        recorded=[]
        fixture=temp/'fixture.png'
        fixture.write_bytes(b'fixture')
        def shared(content,**options):
            recorded.append((content,options))
            return {'ok':True,'asset_id':'shared-asset'}
        try:
            engine._upload_asset_shared=shared
            self.assertEqual(engine.upload_asset('offline-key',fixture,group_name='group'),'shared-asset')
            self.assertEqual(recorded[0][1]['_group_name'],'group')
            for group in ('line\nbreak','x'*1025):
                with self.assertRaises(engine.ApiError):
                    engine.upload_asset('offline-key',fixture,group_name=group)
            self.assertEqual(len(recorded),1)
        finally:
            engine._upload_asset_shared=original

    def test_recovery_get_only_and_persisted_reference(self):
        calls=[]; saved=[]
        def transport(req,timeout):
            calls.append(req)
            self.assertEqual(req.get_method(),'GET')
            self.assertIsNone(req.data)
            self.assertNotIn('Authorization',req.headers)
            self.assertNotIn('Cookie',req.headers)
            return candidate.FakeHTTPResponse(b'{"code":200,"data":{"asset_id":"recovered"}}')
        result=engine.recover_uploaded_asset_for_product('known:task',transport=transport,hooks={'on_asset_id':saved.append})
        self.assertTrue(result['ok'])
        self.assertEqual(saved,['recovered'])
        self.assertEqual(len(calls),1)
        self.assertIn('known%3Atask',calls[0].full_url)

    def test_recovery_invalid_input_zero_network(self):
        def forbidden(*args,**kwargs):
            self.fail('network after invalid input')
        for task in ('', '../task', 'x'*257):
            self.assertFalse(engine.recover_uploaded_asset_for_product(task,transport=forbidden)['ok'])
        for timeout in (float('nan'),float('inf'),True,121,0):
            self.assertFalse(engine.recover_uploaded_asset_for_product('known',transport=forbidden,poll_timeout=timeout)['ok'])

    def test_recovery_save_failure_keeps_both_ids(self):
        def transport(*args,**kwargs):
            return candidate.FakeHTTPResponse(b'{"code":200,"data":{"asset_id":"recovered"}}')
        def fail(_):
            raise RuntimeError('PRIVATE_SENTINEL')
        result=engine.recover_uploaded_asset_for_product('known',transport=transport,hooks={'on_asset_id':fail})
        self.assertEqual(result['outcome'],'asset_id_persisting_failed')
        self.assertEqual((result['task_id'],result['asset_id']),('known','recovered'))
        self.assertNotIn('PRIVATE_SENTINEL',json.dumps(result))

    def test_recovery_pending_timeout_never_submits(self):
        now=[0]; methods=[]
        def transport(req,timeout):
            methods.append(req.get_method())
            return candidate.FakeHTTPResponse(b'{"code":200,"data":{}}')
        def sleep(seconds):
            now[0]+=seconds
        result=engine.recover_uploaded_asset_for_product('known',transport=transport,clock=lambda:now[0],sleep=sleep,poll_timeout=3)
        self.assertEqual(result['outcome'],'poll_timeout')
        self.assertEqual(set(methods),{'GET'})
        self.assertFalse(result['may_resubmit'])

    def test_recovery_cancel_zero_network(self):
        def forbidden(*args,**kwargs):
            self.fail('network after cancellation')
        result=engine.recover_uploaded_asset_for_product('known',transport=forbidden,cancel_token=lambda:True)
        self.assertEqual(result['outcome'],'cancelled')
        self.assertEqual(result['task_id'],'known')

    def test_recovery_checks_after_save_callback(self):
        for mode in ('cancel','timeout'):
            now=[0]; cancelled=[False]
            def transport(*args,**kwargs):
                return candidate.FakeHTTPResponse(b'{"code":200,"data":{"asset_id":"recovered"}}')
            def saved(_):
                if mode=='cancel': cancelled[0]=True
                else: now[0]=4
            result=engine.recover_uploaded_asset_for_product('known',transport=transport,hooks={'on_asset_id':saved},clock=lambda:now[0],cancel_token=lambda:cancelled[0],poll_timeout=3)
            self.assertEqual(result['outcome'],'cancelled' if mode=='cancel' else 'poll_timeout')
            self.assertEqual(result['asset_id'],'recovered')
            self.assertFalse(result['may_resubmit'])

if __name__=='__main__':
    try:
        suite=unittest.TestSuite([unittest.defaultTestLoader.loadTestsFromTestCase(candidate.TestPtAssetUploadProduct),unittest.defaultTestLoader.loadTestsFromTestCase(MainReview),unittest.defaultTestLoader.loadTestsFromTestCase(generation.MainReview)])
        result=unittest.TextTestRunner(verbosity=1).run(suite)
        raise SystemExit(not result.wasSuccessful())
    finally:
        shutil.rmtree(temp)
