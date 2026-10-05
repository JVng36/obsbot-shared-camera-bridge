#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <stdarg.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <time.h>
#include <dirent.h>
#include <linux/limits.h>
#include <linux/videodev2.h>
#include <linux/uvcvideo.h>
#include <jpeglib.h>
#include <poll.h>
#include <assert.h>
static FILE *fixture_out;
static unsigned char *jpeg;
static unsigned long jpeg_len;
static int opens, closes, maps, unmaps, releases, streams, dequeues, waited;
static int mode;
static unsigned long fail_request;
static unsigned requested_w, requested_h;
static int fake_open(const char *p,int flags,...) { (void)p; (void)flags; opens++; return 42; }
static int fake_close(int fd) { (void)fd; closes++; return mode==12?-1:0; }
static void *fake_mmap(void *p,size_t n,int prot,int flags,int fd,off_t off) { (void)p;(void)n;(void)prot;(void)flags;(void)fd;(void)off; maps++; if(mode==18 && maps==2) { maps--;return MAP_FAILED; } return jpeg; }
static int fake_munmap(void *p,size_t n) { (void)p;(void)n; unmaps++; return mode==11?-1:0; }
static int fake_poll(struct pollfd *p,nfds_t n,int timeout) { (void)n;(void)timeout; p->revents=POLLIN; return mode==10?0:1; }
static int fake_nanosleep(const struct timespec *t,struct timespec *r) { (void)r; assert(streams==0); waited+=(int)(t->tv_sec*1000+t->tv_nsec/1000000); return 0; }
static int fake_ioctl(int fd,unsigned long op,...) {
 (void)fd; va_list ap; va_start(ap,op); void *arg=va_arg(ap,void*); va_end(ap);
 if(op==VIDIOC_REQBUFS && ((struct v4l2_requestbuffers*)arg)->count==0) { releases++; return mode==13?-1:0; }
 if (op==fail_request) { if(op==VIDIOC_STREAMON)streams++;return -1; }
 if(op==VIDIOC_S_FMT) { struct v4l2_pix_format *p=&((struct v4l2_format*)arg)->fmt.pix; requested_w=p->width;requested_h=p->height; p->width=mode==1?1920:16;p->height=16;p->sizeimage=4096; if(mode==2)p->pixelformat=V4L2_PIX_FMT_YUYV; if(mode==14)p->sizeimage=6000001;return 0; }
 if(op==VIDIOC_REQBUFS) { ((struct v4l2_requestbuffers*)arg)->count=mode==15?5:2;return 0; }
 if(op==VIDIOC_QUERYBUF) { if(mode==17 && ((struct v4l2_buffer*)arg)->index==1)return -1; ((struct v4l2_buffer*)arg)->length=4096;return 0; }
 if(op==VIDIOC_QBUF)return 0;
 if(op==VIDIOC_STREAMON){streams++;return 0;}
 if(op==VIDIOC_STREAMOFF){streams--;return mode==16?-1:0;}
 if(op==VIDIOC_DQBUF){struct v4l2_buffer *p=arg;dequeues++;p->index=mode==3?8:0;p->bytesused=mode==4?5000:(mode==5?jpeg_len-10:jpeg_len);p->flags=mode==6?V4L2_BUF_FLAG_ERROR:0;return 0;}
 return -1;
}
static int fixture_printf(const char *fmt,...) { va_list ap;va_start(ap,fmt);int r=vfprintf(fixture_out,fmt,ap);va_end(ap);return r; }
static int allocation_failure;
static void *fixture_calloc(size_t n,size_t size) { assert(streams==0); return allocation_failure==1?NULL:calloc(n,size); }
static void *fixture_malloc(size_t n) { assert(streams==0); return allocation_failure==2?NULL:malloc(n); }
#define calloc fixture_calloc
#define malloc fixture_malloc
#define printf fixture_printf
#define open fake_open
#define close fake_close
#define ioctl fake_ioctl
#define mmap fake_mmap
#define munmap fake_munmap
#define poll fake_poll
#define nanosleep fake_nanosleep
#undef stdout
#define stdout fixture_out
#define main helper_main
#define OBSBOT_VERSION "fixture"
#include HELPER_SOURCE
#undef main
#undef printf
#undef calloc
#undef malloc
#undef stdout
static int jpeg_kind;
static void make_jpeg(unsigned w,unsigned h) {
 struct jpeg_compress_struct c; struct jpeg_error_mgr e;c.err=jpeg_std_error(&e);jpeg_create_compress(&c);jpeg_mem_dest(&c,&jpeg,&jpeg_len);c.image_width=w;c.image_height=h;c.input_components=3;c.in_color_space=JCS_RGB;jpeg_set_defaults(&c);
 jpeg_scan_info scans[3]={{0}};
 if(jpeg_kind==1){for(int i=0;i<3;i++){scans[i].comps_in_scan=1;scans[i].component_index[0]=i;scans[i].Ss=0;scans[i].Se=63;}c.scan_info=scans;c.num_scans=3;}
 if(jpeg_kind==2)jpeg_simple_progression(&c);
 jpeg_start_compress(&c,TRUE);unsigned char row[1280*3]={0};while(c.next_scanline<h){JSAMPROW r=row;jpeg_write_scanlines(&c,&r,1);}jpeg_finish_compress(&c);jpeg_destroy_compress(&c);
}
static void run(int m,int success) {
 mode=m;opens=closes=maps=unmaps=releases=streams=dequeues=waited=0; char *out=NULL;size_t len=0;fixture_out=open_memstream(&out,&len); do_snapshot("synthetic",1280,85,600);fclose(fixture_out);
 assert(strstr(out,success?"\"ok\":true":"\"ok\":false"));assert(opens==closes);assert(maps==unmaps);assert(streams==0);if(m!=1&&m!=2&&m!=14)assert(releases==1);if(success){assert(requested_w==1280&&requested_h==720);assert(dequeues==1);assert(waited==600);}free(out);
}
int main(void){
 make_jpeg(16,16);
 run(0,1);
 allocation_failure=1;run(0,0);allocation_failure=2;run(0,0);allocation_failure=0;
 int rejected[]={1,2,3,4,5,6,10,11,12,13,14,15,16,17,18};
 for(unsigned i=0;i<sizeof(rejected)/sizeof(*rejected);i++)run(rejected[i],0);
 unsigned long failed[]={VIDIOC_REQBUFS,VIDIOC_QUERYBUF,VIDIOC_QBUF,VIDIOC_STREAMON,VIDIOC_DQBUF};
 for(unsigned i=0;i<sizeof(failed)/sizeof(*failed);i++){fail_request=failed[i];run(0,0);}fail_request=0;
 char b[5];assert(base64_encode((uint8_t*)"abc",3,b,4)<0);
 assert(base64_encode((uint8_t*)"abc",3,b,5)==4&&!strcmp(b,"YWJj"));
 long d,q,t;
 assert(snapshot_options("{\"op\":\"snapshot\"}",&d,&q,&t)==0&&d==1280&&q==85&&t==600);
 const char *bad[]={"0","1281","-1","1.5","1e3","Infinity","NaN","999999999999999999999","\"1280\"","true","null","1junk","01"};
 for(unsigned i=0;i<sizeof(bad)/sizeof(*bad);i++){char json[256];snprintf(json,sizeof(json),"{\"op\":\"snapshot\",\"maxDim\":%s}",bad[i]);assert(snapshot_options(json,&d,&q,&t)<0);}
 assert(snapshot_options("{\"maxDim\":1,\"maxDim\":2}",&d,&q,&t)<0);
 assert(snapshot_options("{\"quality\":101}",&d,&q,&t)<0);
 assert(snapshot_options("{\"settleMs\":5001}",&d,&q,&t)<0);
 assert(snapshot_options("{\"maxDim\":1,\"quality\":1,\"settleMs\":0}",&d,&q,&t)==0);
 assert(validate_jpeg(jpeg,jpeg_len,17,16)<0);
 unsigned char old=jpeg[2];jpeg[2]=0;assert(validate_jpeg(jpeg,jpeg_len,16,16)<0);jpeg[2]=old;
 unsigned char *trailing=malloc(jpeg_len+3);memcpy(trailing,jpeg,jpeg_len);trailing[jpeg_len]=42;trailing[jpeg_len+1]=255;trailing[jpeg_len+2]=217;assert(validate_jpeg(trailing,jpeg_len+3,16,16)<0);free(trailing);
 free(jpeg);jpeg=NULL;jpeg_len=0;jpeg_kind=1;make_jpeg(16,16);
 assert(validate_jpeg(jpeg,jpeg_len,16,16)<0);
 free(jpeg);jpeg=NULL;jpeg_len=0;jpeg_kind=2;make_jpeg(16,16);
 assert(validate_jpeg(jpeg,jpeg_len,16,16)<0);
 free(jpeg);puts("native snapshot fixture passed");return 0;
}
