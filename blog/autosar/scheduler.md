# 基于简单模型的scheduler实现
## 需求分析
对于vector rtos scheduler的设计有两个基本的设计需求：

1. 对于不同优先级的task，按照优先级的高低进行调度
2. 对于相同优先级的task，按照激活的先后顺序进行调度

## 模型抽象
对于这两条需求，可以抽象出两个基本模型
1. 对于不同优先级的task，因为按照优先级的**大小**进行调度，所以可以抽象出是和[alarm一样的](./alarm1.html)**排序模型**。
2. 对于相同优先级的task，因为按照激活的**先后**先后进行调度，可以抽象出是一个**队列模型**

## 代码实现
根据上述两个模型实现一个简单的scheduler。该scheduler拥有两个接口：
1. task激活时调用**inform_scheduler**,通知scheduler task被激活可以被调度
2. 当中断返回，wait_event或者task结束时调用**schedule**，选择合适的task进行切换

对于上述的两个简单模型，可以参考[M6.046J](https://www.bilibili.com/video/BV1Kx411f7bL/?spm_id_from=333.337.search-card.all.click),有多种实现方式。这里采用vector的方式：用bitmap实现排序模型；用数组实现队列模型

```
#define Array_size(array)	(sizeof(array)/sizeof(array[0]))
#define NR_PRIORITY			(100)

typedef struct task
{
	unsigned int priority;
	context *context;
}Task;

typedef struct Queue
{

	int			write_idx;
	int			read_idx;
	Task*		task[SAME_PRIORITY+1];
	spinlock_t queue_lock;
}Queue;




/*剑指offser算法题10,也可以直接循环(1<<i)&s
**另外infenion 上有对这个函数的指令级实现
*/
inline int find_first_one(unsigned int s )
{
	/*如果不加前置判断，count为32是无效的*/
	if(!s)
		return -1;
	unsigned int count=0,t=(s-1)^s;
	while(t)
	{
		count++;
		
		t=(t-1)&t;
	}

	return count-1;
}
```

```
#include "sched.h"
unsigned int task_bitmap[NR_PRIORITY/sizeof(unsigned int)];
spinlock_t bit_lock=0;

Queue task_queue[NR_PRIORITY];

void inform_scheduler(Task *task)
{
	int prior=task->priority;
		
	//队列模型输入
	Queue queue=task_queue[prior];
	spin_lock(queue.queue_lock);
	
	queue.task[queue.write_idx]=task;
	queue.write_idx=(queue.write_idx+1)%Array_size(queue.task);
	assert( queue.write_idx != queue.read_idx);//队列满了，报错
	
	spin_unlock(queue.queue_lock);
	
	//排序模型输入
	spin_lock(bit_lock);
	task_bitmap[ prior/sizeof(int) ] |= (1<<(prior%sizeof(int)));
	spin_unlock(bit_lock);
	
}

void schedule()
{

	int i=0,prior=-1;
	Task *task=NULL;
	//排序模型输出
	spin_lock(bit_lock);
	for(;i<Array_size(task_bitmap);i++)
	{
		if(  (prior = find_first_one(task_bitmap[i]) ) != -1  )
			break;
	}
	spin_unlock(bit_lock);
	assert(prior!=-1);
	
	prior=i*8*sizeof(unsigned int)+prior;
	
	//队列模型输出
	Queue queue=task_queue[prior];
	spin_lock(queue.queue_lock);
	
	assert( queue.read_idx!=queue.write_idx);//队列空的，报错
	
	task=queue.task[queue.read_idx];
	queue.read_idx=(queue.read_idx+1)%Array_size(queue.task);
	
	spin_unlock(queue.queue_lock);
	
	switch_task(task->context);//切换task的上下文
	
}
```