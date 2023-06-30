# Btrfs之RAID(二)：RAID读写
Btrfs在读(__do_readpage)写(btrfs_writepages)文件时，会查询inode的逻辑地址到底层的映射(extent_map)。如果使用[RAID](./btrfs_raid1.html)将device抽象成chunk，那么Btrfs在extent_map中查询到的是chunk的地址，所以需要RAID进一步将chunk的地址映射到device上，然后根据RAID类型对相应的device进行读写。

## Btrfs提交bio
submit_extent_page将btrfs的读写请求封装成bio，用于给RAID或者设备层进行处理。在将读写请求封装成bio时，merge_bio会尽量将连续的读写请求合并成一个bio，使bio请求更适应于底层RAID和设备的特性。

>注：
>
>1. bio中的设备信息
>
>   bio.bi_bdev:表示btrfs对应的底层设备(可以是RAID的映射，也可以是device)
>
>   bio.bi_iter.bi_sector:表示bio要操作的*设备*的起始sector(512字节为一个sector)
>
>   bio.bi_iter.bi_size:表示bio请求的数据的字节数
>
>2. bio中的数据信息
>
>   bio.bi_io_vec:记录bio请求读写的page，page偏移bv_offset，以及在page中的长度bv_len
>
>   bio.bi_max_vecs：记录一个bio提供bi_io_vec的个数
>
>   bio.bi_vcnt:记录要提交的bi_io_vec的个数

merge_bio在btrfs中默认被实现为btrfs_merge_bio_hook，主要用来确定对应RAID类型在每个bio中的最大请求长度。

| 最大bio.bi_iter.bi_size | RAID0/RAID1/RAID10/RAID_DUP |        RAID5/RAID6         |       其他       |
| :---------------------: | :-------------------------: | :------------------------: | :--------------: |
|           WR            | stripe_len - stripe_offset  |     full_stripe-offset     | em->len - offset |
|           RD            | stripe_len - stripe_offset  | stripe_len - stripe_offset | em->len - offset |

> strip_len:	表示一个stripe在单个device上的长度(一个红色标号)
>
> full_strip:	表示一个stripe中数据的长度(排除校验长度)
>
> em.len:		表示一个chunk的长度
>
> offset：	   表示读写我位置在stripe_len或者full_stripe或者em.len中的偏移

## chunk映射到device
当btrfs将读写请求封装到bio中后，会通过submit_one_bio将bio提交给底层设备RAID。RAID只是一层为了防止存储设备失效，提升读写速率而抽象出的虚拟设备，所以RAID会通过__btrfs_map_block 将btrfs提供的chunk地址解析成相应的device地址，从而进行读写操作。

```c
static int __btrfs_map_block(struct btrfs_fs_info *fs_info, int rw,
			     u64 logical, u64 *length,
			     struct btrfs_bio **bbio_ret,
			     int mirror_num, int need_raid_map)
{
    /*
    1. btrfs_merge_bio_hook查询btrfs bio中的读写长度(参数列表中的length)时，就是通过__btrfs_map_block完成的。但是这个函数没指定bbio_ret，所以只是查询读写的长度(RAID56在写的时候是整个stripe，其他情况下的RIAD都是一个strip_len)，并没有将bio映射成相应的实际设备信息bbio
    */
    
    /*
    2.如果需要RAID映射的实际设备信息，需要提供bbio_ret，其会将设备信息以bbio的形式提供给RAID
    	1.确定读写的stripes数(除RAID_DUP外，就是设备数)--->bbio.num_stripes
    		RAID0           RAID1           RAID10           RAID56          RAID_DUP
    	wr	1               num_stripes     sub_stripes      num_stripes     num_stripes
    	RD	1               1               1                1               1
    	2.确定要读写的stripe(stripe_nr),以及在stripe中的偏移(stripe_index)--->bbio.stripes
    		-对于RAID1,stripe_nr没发生改变，是因为一个stripe的chunk长度就是stripe_len，其他的空间都是备份.其选择的stripe_index默认是0.
    		
    		-对于RAID56，如果need_raid_map，会将dvice中chunk的逻辑地址放到bbio.raid_map(索引是stripes，如果不是RAID_DUP,就是device index)中。后面会通过sort_parity_stripes对数组raid_map和stripes(索引也是device index)进行排序，两个数组的索引就变成了chunk的偏移(raid_map中记录chunk地址，striped记录chunk对应device地址)
    		注：
    		1.为了保证RAID56在随机读时具有比较好的读写性能，会将p q stripe均匀的分布到各个设备上，具体做法是：
    		  随着stripe_nr的不同，每一个stripe起始地址会偏移一个device。
    		2.need_raid_map只会在RAID56写或者读取p q stripe时，才会设置raid_map。在读普通RAID56 stripe时不会设置。
    		
    		-bbio.stripes返回之后，都是以chunk逻辑地址为索引，存储着device和physical
    	3.确定设备的index mirror_num(和stripe_index类似，但是在RAID56中2,3分别表示p，q stripe)--->bbio.mirror_num 
    	4.确定能出错的最大设备数max_errors(读的max_errors默认是0)--->bbio.max_errors
    					RAID0       RAID1       RAID10       RAID5       RAID6        RAID_DUP
				WR      0           1           1            1           2            1
    */
}
```

> 注：
>
> - 对于__btrfs_map_block而言，是将chunk地址转换成device的地址，通过bbio返回给caller进行数据的读写。
>
> - 对于btrfs_rmap_block而言，是将device地址(exclude_super_stripes中会提供super_block的device地址)转换成对应的chunk地址(这一段地址会记录到pinned中，使其不被申请)
>
>   1.  找到chunk_start对应的em，从而获取到其底层RAID设备信息map
>
>   2.  在map中查找physical所处的stripes(如果不是RAID_DUP，就是device)，根据physical的偏移计算出其所在的stripe_nr（一般是指   stripe的数目，但是在RAID0或者RAID10中指的是stripe_len的个数）
>
>   3.  根据chunk_start和stripe_nr计算出chunk地址，并记录到数组logical中

## RAID提交bio

__btrfs_map_block将chunk地址映射到device上之后，RAID会将Btrfs传来的读写请求bio提交给device。

1.  普通RAID读写

在Btrfs提交bio时，普通RAID每次的bio请求只能是一个stripe_len，但是可能因为RAID类型的不同，需要在不同的stripes上备份。

```c
int btrfs_map_bio(struct btrfs_root *root, int rw, struct bio *bio,
		  int mirror_num, int async_submit)
{
	... ...
	/*返回的bbio中有着RAID映射的device信息*/
	ret = __btrfs_map_block(root->fs_info, rw, logical, &map_length, &bbio,
			      mirror_num, 1);
	... ...
	/*遍历bbio中的所有设备bbio.num_stripes,向每个设备中写同一份bio内容(因为普通RAID读写的最大长度是stripe_len，所以bio中的page的内容一个device上就可以容纳，其他盘上是备份)*/
	for (dev_nr = 0; dev_nr < total_devs; dev_nr++) {
		dev = bbio->stripes[dev_nr].dev;
		if (!dev || !dev->bdev || (rw & WRITE && !dev->writeable)) {
			bbio_error(bbio, first_bio, logical);
			continue;
		}

		/*复制一份bio，提交请求，直到最后一个device*/
		if (dev_nr < total_devs - 1) {
			bio = btrfs_bio_clone(first_bio, GFP_NOFS);
			BUG_ON(!bio); /* -ENOMEM */
		} else
			bio = first_bio;

		/*
		功能：将bio中的设备信息换成要写的device(bi_sector,bi_bdev)，并提交bio请求
		*/
		submit_stripe_bio(root, bbio, bio,
				  bbio->stripes[dev_nr].physical, dev_nr, rw,
				  async_submit);
	}
	... ...
}
```
>注：普通RAID读写出错处理方式:在btrfs_end_bio中只要出错次数超过了bbio.max_errors,就会报EIO.
>
>​		1.对于RAID1,RAID10,RAID_DUP写请求，需要出错两次就会报EIO,Btrfs会设置page_error
>
>​		2.对于RAID1,RAID10,RAID_DUP读请求，只要出错一次，就会通过end_bio_extent_readpage上报fault，Btrfs会更换mirror(备份)读取正确的值，错误的mirror将会记入到io_tree中.如果所有的mirror读取出错，Btrfs会设置page_error
>
>​		3.对于RAID56普通stripes读取，会读取两次stripes(如果出错，mirror0和mirror1)；如果继续失败，会将整个full_stripe读进内存(mirror2)，并且会在raid56_parity_recover中验证find_logical_bio_stripe；如果还是失败，会再次将整个full_stripe读进内存(mirror 3)，会验证第一个和最后一个stripes。
>

2.  RAID56读写

对于RAID56，其普通stripes的读操作是通过上述的普通RAID读取的，但是其写操作和读取错误后的操作因为其校验特性，与其他RAID类型不同，需要将整个stripe读进内存并重新计算p q stripe。

```c
int btrfs_map_bio(struct btrfs_root *root, int rw, struct bio *bio,
		  int mirror_num, int async_submit)
{
	... ...
	/*
	函数分析：
		1.need_raid_map置上，因为RAID56时，p q stripe在设备上均匀分布，需要通过raid_map将stripes数组按照chunk的顺序重新排序(对于其他RAID,chunk的顺序就是device的顺序)
		2.map_length和在btrfs_merge_bio_hook查询的不同，后面会在写的情况下更新为stripe_len
	*/
	ret = __btrfs_map_block(root->fs_info, rw, logical, &map_length, &bbio,
			      mirror_num, 1);
	... ...
    /*
    	1.raid_map和need_raid_map处理相关
    	2.在RAID56普通stripe读时，因为没有设置raid_map，过程是和普通RAID读写相同的
    	3.这里处理RAID56的写，和mirror 3（q stripe）的读
    */
	if (bbio->raid_map) {
		/* In this case, map_length has been set to the length of
		   a single stripe; not the whole write */
		if (rw & WRITE) {
		/*
		功能：RAID56所有的写操作，在full_stripe时直接写，在partion_stripe时会等待或者从磁盘读取除bio外的所有stripe
		函数分析：
			1.如果是写整个stripe，通过full_stripe_write将stripe落盘
				- lock_stripe_add用于将rbio添加到stripe_hash_table，并且查看是否可以和hash表中其他rbio合并(chunk的首地址相同)
					1.如果hash表中的rbio已经写完，并且其full_stripe被cache，将其中的page通过steal_rbio放到当前rbio的stripe_pages数组中后将其释放
					2.如果其或则其plug_list没有写，将两者的bio_list合并一起写
					3.否则将当前rbio加入其plug_list中
				注：先看是否可以删除rbio;再看是否可以不删rbio但是可以不增rbio(添加到rbio的bio_list，记录着上层传递的bio)；然后看是否添加rbio到该hash bucket的plug_list中;最后添加rbio到对应hash bucket中
				
				- finish_rmw完成full_stripe的校验(不是full_strip不能运行finish_rmw),并且将要写的chunk数据重新封装为bio提交给磁盘
					1.以page为单位计算一个stripe上的p q stripe。
					2.rbio_add_io_page将bio_pages中的数据和p q stripe中的数据重新封装成bio(和普通的RAID不同，上层提交的bio此时在rbio.bio_list中)，提交请求给磁盘
					3.写请求结束后，会调用raid_write_end_io结束写请求
						- 根据磁盘bio.private找到RAID层的rbio
						- 如果出错，通过fail_bio_stripe将failed的stripe放到faila和failb中
						- rbio.stripes_pending记录了所有要做磁盘bio的数目
						- 如果rbio中所有的底层bio全部请求结束，rbio_orig_end_io会结束rbio，并将err传递给 btrfs bio(rbio.bio_list)
							- free_raid_bio在释放rbio时，会通过unlock_stripe处理合并的请求
								1.合并到rbio.bio_list中的请求不是在这里处理，而是在index_rbio_pages中合并为 一个full_stripe后作为一个底层bio向底层请求
								2.unlock_stripe会处理plug_list的请求(将steal_rbio从处理完的rbio中stripe_pages拿过来凑足full_stripe)，如果请求处理完，会通过cache_rbio将rbio放到stripe_hash_table的lru链表中(lru链表rbio数目有上限，如果超过上限会将最早的rbio通过__remove_rbio_from_cache删除)
				注：stripe_pages数组中存储的是cached的数据，index_rbio_pages会将要写的数据放到bio_pages数组中
				
			2.如果只是写部分的stripe
				- 如果存在current.plug，将rbio连接到plug.rbio_list，用于和之后的rbio合并成一个full_stripe后落盘
				- 如果没有plug，通过__raid56_parity_write将rbio进行异步读写(通过raid56_rmw_stripe进行读写)
					-raid56_rmw_stripe将full_stripe中剩余的page封装成bio读到内存，完成之后通过raid_rmw_end_io处理如下
						1.发现有读错误，通过fail_bio_stripe记录，否则数据是正常读进，set_bio_pages_uptodate
						2.如果没有读取完规定的stripes_pending，不做错误处理继续读
						3.读取完成之后，错误处理
							-如果整个rbio出错超过了max_errors，直接返回btrfs bio EIO
							-如果出现预期内错误，通过__raid56_parity_recover恢复(参见下面的分析)
							-如果没出错，通过finish_rmw完成整个stripe的写操作
		*/
			ret = raid56_parity_write(root, bio, bbio, map_length);
		} else {
		 /*
		 功能：用于q stripe的读取，或者REQ_GET_READ_MIRRORS读取整个stripe
		 函数分析:
		 	1.REQ_GET_READ_MIRRORS的情况下会默认校验(默认置上faila)
		 	2.如果读取mirror3，会通过p q stripe校验最后一个stripes(置上failb)
		 	3.会通过__raid56_parity_recover完成p q stripe的校验
		 		-如果full_stripe没读进来，会通过rbio_add_io_page将读取数据封装成bio向底层提交请求
		 		-full_stripe读取完成发现有预期内的错误(faila,failb),通过__raid_recover_end_io做数据的恢复
		 			1.通过p q stripe恢复数据后，将恢复的数据设置为SetPageUptodate
		 			2.如果是读取正确恢复，会将数据缓存到stripe_pages中，并通知Btrfs
		 			3.如果是parition_stripe写操作，读取正常恢复，会继续通过finish_rmw完成full_stripe落盘
		 			4.当replace dev时，会将rbio标记为BTRFS_RBIO_PARITY_SCRUB，用于replace tgt_dev上parity的数据
		 			  - 首先通过raid56_parity_scrub_stripe将要求恢复的page数组rbio.dbitmap中标记的一个stripe中的page读进内存
		 			  - 如果读取出现预期内的错误，会在validate_rbio_for_parity_scrub中__raid_recover_end_io
		 			  - 当磁盘上的full_stripe对应的page读进内存后，通过finish_parity_scrub重新计算parity进行比较，
		 			  	如果不同需要将parity写到磁盘
		 */
			ret = raid56_parity_recover(root, bio, bbio, map_length,
						    mirror_num, 1);
		}

		btrfs_bio_counter_dec(root->fs_info);
		return ret;
	}
	... ...
}
```