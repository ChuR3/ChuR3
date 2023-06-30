# Btrfs之RAID（三）：RAID应用
在Btrfs中由于Btree有着很好的扩展性，使得底层存储设备也能随之增添、移除或者替换。这些存储设备组成一个存储池，经过RAID抽象后供Btrfs使用。这会使得RAID在加快文件读写速度，设备失效后数据恢复的同时，也能使Btrfs在存储特性上更加[均衡且灵活](https://zhuanlan.zhihu.com/p/26722779)

## __btrfs_balance
当业务扩展时，可以通过"btrfs device add"命令将新磁盘加入到Btrfs系统中，增加Btrfs的容量。但是此时数据在磁盘上的分布是不均匀的，多个磁盘的RAID性能没办法完全发挥出来，所以可以通过"btrfs balance start"命令将数据均匀分布到各个磁盘上。

根据 [Btrfs之RAID(一)：Chunk抽象和使用](./btrfs_raid1.html) 可知，RAID在申请chunk时，chunk空间是均匀分布到各个设备上。所以"btrfs balance"是重新申请chunk，将原来所有的chunk relocate到新的chunk上(在Btrfs数据比较多时，将所有chunk重新relocate将会花比较多的时间)
```c
static int __btrfs_balance(struct btrfs_fs_info *fs_info)
{
	/*
	功能分析：遍历btrfs上所有的device，将device腾出足够的空间供后续的chunk relocate
	函数分析：
	1.btrfs_shrink_device会遍历device对应的所有dev_extent，将超过new_size的dev_extent通过btrfs_relocate_chunk进行重定位
	注：btrfs_shrink_device限制了device.total_bytes,所以在relocate时如果能找到原有的free_extent不会增加任何device的长度；如果不能找到需要重新alloc_chunk，当前device也只会在new_size内申请，并且新device上也会申请空间。
	2.btrfs_grow_device将device的实际大小记录恢复到old_size
	*/
	devices = &fs_info->fs_devices->devices;
	list_for_each_entry(device, devices, dev_list) {
		... ...

		ret = btrfs_shrink_device(device, old_size - size_to_free);
		... ...

		ret = btrfs_grow_device(trans, device, old_size);
		... ...
	}
	... ...
	/*
	功能分析：遍历Btrfs中所有的chunk，首先会通过btrfs_force_chunk_alloc新申请chunk，再通过btrfs_relocate_chunk将chunk relocate到新的chunk上
	函数分析：
	1.btrfs_force_chunk_alloc申请chunk后，会通过btrfs_end_transaction刷写dev_extent，保证再次alloc_chunk时find_free_dev_extent所查找的结构是正确的。
	2.btrfs_relocate_chunk relocate chunk所在的blockgroup
		1.btrfs_can_relocate通过find_free_dev_extent查找device中是否存在要重定位的大小(block_group已使用长度重新分布到各个device上)
		2.btrfs_relocate_block_group
			- btrfs_lookup_block_group查找包含chunk的block_group(block_group_cache_tree_search中contain置上，保证找到的block_group包含了chunk_start)
			- btrfs_inc_block_group_ro递增block_group.ro，保证在find_free_extent时不适用block_group的空间
			- delete_block_group_cache通过btrfs_truncate_inode_items将free_space_inode删除
				1.btrfs_drop_extent_cache将inode到chunk的映射em删除
				2.将inode的extent_data记录清空，并且通过btrfs_free_extent释放所有包含inode数据的extent
				3.保留了inode_item,inode_item是在btrfs_remove_block_group中删除
			- btrfs_start_delalloc_roots和btrfs_wait_ordered_roots会等待所有的inode数据落盘
			- relocate_block_group将rc记录的block_group重定位
				1.初始时在MOVE_DATA_EXTENTS状态，relocate_block_group中会重定位block_group中所有的tree_block_ref(btree所占据的区域，metadata)和data_ref(inode的extent_data_key对应的区域)，并且将block_group下所有的extent_data读进内存
				2.btrfs_wait_ordered_range等待extent_data落盘(此时data在data_inode中的逻辑地址是其在block_group中的偏移)
				3.rc状态迁移到UPDATE_DATA_PTRS，这里会对btree中对extent_data的block进行relocate,然后将extent_data指向MOVE_DATA_EXTENTS时重定位的data_ref
			注：btrfs_relocate_block_group在create_reloc_inode创建rc.data_inode时，将btrfs_inode.index_cnt赋值为blockgroup的chunk_offset(group->key.objectid;)
	3.btrfs_remove_chunk删除原有的chunk
              - btrfs_free_dev_extent将chunk对应dev_extent释放
              - btrfs_free_chunk将chunk记录删除
              - btrfs_remove_block_group将包含真实free_space(可供申请的空间)的inode删除；将总free_space空间(block_group的总空间)信息删除；将包含free_space的block_group删除
	*/
again:
	... ...
	key.objectid = BTRFS_FIRST_CHUNK_TREE_OBJECTID;
	key.offset = (u64)-1;
	key.type = BTRFS_CHUNK_ITEM_KEY;
	... ...
	while (1) {
		... ...
		ret = btrfs_search_slot(NULL, chunk_root, &key, path, 0, 0);
		... ...
		if ((chunk_type & BTRFS_BLOCK_GROUP_DATA) && !chunk_reserved) {
		... ...
			ret = btrfs_force_chunk_alloc(trans, chunk_root,BTRFS_BLOCK_GROUP_DATA);
		... ...
		}
		ret = btrfs_relocate_chunk(chunk_root,found_key.offset);
		... ...
	loop:
		if (found_key.offset == 0)
			break;
		key.offset = found_key.offset - 1;
	}
	... ...
}
```
relocate_block_group将原来chunk上的数据重定位到新申请的chunk上，使数据均衡的分布到各个设备上。
```c
static noinline_for_stack int relocate_block_group(struct reloc_control *rc)
{
	while (1) {
	... ...
restart:
	... ...
	/*
	功能：遍历block_group中所有的extent_item_key和metadata_item_key，如果该item没在rc->processed_blocks设置为dirty，即为要重定位的block
	注：
	1.extent_item描述的是chunk空间，在每次alloc_chunk用于tree_block或者extent_data时，都会通过delay_ref插入extent_item_key
	2.metadata_item是在SKINNY_METADATA置上时，描述tree_block chunk空间的特殊情况，插入时间和extent_item类似
	3.申请的chunk空间可以如果用于tree_block，有以下两种类型的引用
		1.tree_block_ref_key，其iref.offset指向的是root
		2.shared_block_ref_key，其iref.offset指向upper.eb.start，是full_ref.
	4.申请的chunk空间可以如果用于extent_data，有以下两种类型
		1.extent_data_ref_key,其ref.root ref.objectid  ref.offset  ref.count分别表示其所在的root，其所在的inode，其在inode中的逻辑偏移，其被inode引用的次数。
		2.shared_data_ref_key，其iref.offset指向其upper.eb.start，是full_ref
	5.full_ref是引用block或者extent_data的root不是最原始的root，此时不用普通的ref(parent是root)，而用full_ref(parent是parent_block),以下情况可能会有full_ref
		1.relocat_root中，因为relocate_root是一个临时的root，最终会删除，所以会直接有full_ref
		2.当drop_snapshot时，可能会删除源root对shared_block的索引，因为root发生改变，shared_block会将其底层所有引用的tree_block换成full_ref
	*/
	ret = find_next_extent(rc, path, &key);
	... ...
	if (flags & BTRFS_EXTENT_FLAG_TREE_BLOCK) {
		/*
		功能分析：如果extent_item是tree_block，通过add_tree_block将tree_block的信息加入到红黑树blocks中
		注：这个extent_item在MOVE_DATA_EXTENTS被relocate，所以其extent_item在processed_blocks中会被标记dirty(在relocate_tree_block时，btrfs_cow_block通过btrfs_reloc_cow_block将重定位的node标记为dirty)。将所以在UPDATE_DATA_PTRS时已经搜索不到在block_group中的tree_block
		*/
		ret = add_tree_block(rc, &key, path, &blocks);
	} else if (rc->stage == UPDATE_DATA_PTRS &&
		   (flags & BTRFS_EXTENT_FLAG_DATA)) {
		 /*
		 功能分析：在relocate的第二阶段，需要找到引用extent_data的tree_block，因为在第一阶段已经将extent_data relocate，所以需要更新这些tree_block的reference
		 函数分析：
		 1.对于share_data_ref，因为其iref.offset直接指向的是其upper.eb.start，所以直接通过__add_tree_block将upper加到红黑树blocks中
		 2.对于extent_data_ref，find_data_references会在root中找其inode相应的offset对应extent_data_key所在的tree_block
			- 如果extent_data中存储的是free_space(链接在tree_root下)，直接通过delete_block_group_cache删除而不relocate(后面释放data_inode时会将已经relocate的extent_data和extent_item删除)
			- 如果存储的是普通文件，可能分为多段存储到extent上。iref.offset是指inode在这个extent上的第一个逻辑地址.每段extent_data.offset-fi.offset(相对第一段的偏移)要相等
		 */
		ret = add_data_references(rc, &key, path, &blocks);
	}
        ... ...
       if (!RB_EMPTY_ROOT(&blocks)) {
           	    /*
           	    功能分析：MOVE_DATA_EXTENTS 或者 UPDATE_DATA_PTRS有需要relocate的tree_block或者reference，通过relocate_tree_blocks进行重定位
           	    函数分析：
           	    1.通过readahead_tree_block将所有要relocate的tree_block读进内存，通过get_tree_block_key找到tree_block slot0的key
           	    2.build_backref_tree建立引用block的所有关系(通过edge链接)，shared_block只向上走一层，tree_block走到root；然后利用宽度优先算法依次向上check shared的upper；最后找到所有引用block的路径(最开始的node.root指向path所在的root)
           	    	-edge.node数组分别存放lower和upper；edge.list数组链表分别链接到lower.upper和upper.lower链表中
           	    	-.build_backref_tree既遍历了extent_item和metadata_item的inline_ref，也遍历了其显性的extent_ref和shared_ref
           	    3.relocate_tree_block对block进行重定位。引用block的path因为其reference发生改变，所以需要对所有引用block的path进行COW
           	    	-select_one_root返回的root有以下4中情况
           	    		1.cow没置上的root，btrfs_search_slot对整条path进行cow，实现block的重定位
           	    		2.cow置上的node本身是root，btrfs_record_root_in_trans直接对root进行重定位
           	    		3.node被cow root引用，返回NULL；通过do_relocation对block进行重定位，对path进行COW
           	    		4.只有relocate_root，返回ENOENT
           	    	-做完block的重定位后，通过update_processed_blocks将所有引用block的node都标记为processed。
           	    	-do_relocation遍历引用node的所有upper，将root~upper的路径做cow，并cow node，更新upper引用node的引用
           	    		1.不直接对整条路径做cow，是因为引用node的path可能很多，如果多条path有公用的路径，因为在btrfs_reloc_cow_block设置了upper.eb，所以不会对公用路径进行重复的COW.
           	    		2.select_reloc_root会选取一个被relocate的root,，如果没被relocate会通过btrfs_record_root_in_trans申请(walk_up_backref会向上找到一个引用node的路径；walk_down_backref会利用宽度优先算法依次向下寻找同一层的node，如果找不到会继续向下一层查找)
           	    		3.在对path和node进行cow时，会将node.pending置上(node的pending会在最后处理完之后清掉)并连接到rc.backref_cache.pending，最后会在finish_pending_nodes中通过link_to_upper对upper的所有引用path通过do_relocation进行cow
           	    		4.node.lock将会在其子node全部relocate之后，会通过drop_node_buffer或者unlock_node_buffer进行解锁
           	    		5.如果子node已经relocate，那么会直接更新node在upper中的引用，并通过btrfs_drop_subtree(和下面的btrfs_drop_snapshot类似)删除upper对原有node的索引
           	    4.finish_pending_nodes遍历rc.backref_cache.pending在relocate_tree_block中没完全更新索引的upper，采用宽度优先算法向上依次将所有的引用path全部更新。
           	    */
		ret = relocate_tree_blocks(trans, rc, &blocks);
	...
	}
        ... ...
        if (rc->stage == MOVE_DATA_EXTENTS &&
            (flags & BTRFS_EXTENT_FLAG_DATA)) {
            rc->found_file_extent = 1;
            /*
            功能分析：为rc.data_inode prealloc空间并建立em(逻辑地址是在block_group中的偏移，内容是block_group中的数据)存储block_group中连续的extent_item 
            函数分析：
            1.每一段连续的extent_item都会通过relocate_file_extent_cluster在data_inode中建立映射
            	-prealloc_file_extent_cluster会为block_group中的数据重新申请chunk空间，建立inode到数据的索引(插入extent_data并且建立em)
            	-setup_extent_mapping重新建立data_inode的索引到原来的block_gruop数据，以便可以将所有要relocate的数据读进内存
            */
            ret = relocate_data_extent(rc->data_inode,
                                       &key, &rc->cluster);
        ... ...
        }
    }
    ... ...
    /*
    功能分析：将record_root_in_trans中记录的所有relocate_root重定位的tree_block和extent_data通过merge_reloc_root合并到原来的root中，并通过btrfs_drop_snapshot删除relocate_root
    函数分析：
    1.merge_reloc_root将relocate_root中重定位的部分和源root中做替换
		-walk_down_reloc_tree找到一条在last_snapshot之后(relocate_root.last_snapshot在create_reloc_root中设置)的path，并确定最底层的lowest_level;如果找到返回0，否则返回1。
		-find_next_key在path中找到一个有效的key，如果这个key在next_key(做replace_path的左边界，初始值是0)右边(比next_key大)才会处理，否则会跳过
		-replace_path将max_level~lowest_level之间被重定位的path和源root做交换
			1.在最开始时，cow没置上，会max_level~lowest_level之间是否存在block没发生改变，并且key完全相同的eb，查看检查dest中是否还存在src中被重定位的key;如果有再将cow置上，表示这条path需要被替换
			2.next_key在最开始时被赋值为最大值，然后在遍历path的时候都会更新为next_slot，保证是当前处理key的next_key
			3.当找到key后，会交换relocate_root和源root之间key对应的子树(直接交换block和gen，并更新索引)，做完交换后便退出
		-walk_up_reloc_tree从walk_down_reloc_tree找到的key开始继续向右边遍历，找到被重定位的slot;如果找到返回0，否则返回1。
		-会记录当前relocate_root正在处理的drop_level和drop_progress(key),如果异常退出，会继续从记录的位置开始重定位
    2.btrfs_drop_snapshot
		-如果root已经被rolocate完成，需要从relocate_root开始删除，否则会从drop_progress开始删
		-walk_down_tree向下遍历找到一条ref为1的path
			1.walk_down_proc在drop_reference的情况下，会找到一条ref为1的path，直到ref不为1或者遍历到leaf。在update_ref的情况下如果发现block的root发生改变，会一直找到leaf，并且将ref更新为full_ref
			2.do_walk_down会继续向下遍历，返回0表示继续向下处理block，返回1表示平级处理block(slot++，并且需要重新lookup_info查找ref和flags)
				-从drop_ref转换为update_ref，需要block的ref>1,并且wc.update_ref需要置上(这个标志需要在btrfs_copy_root中将BTRFS_MIXED_BACKREF_REV置上，表示这个root有和其他root共用ref，这样在drop_snapshot的时候，需要删除root cow的block(gen在root的创建之后))
				-update_ref，不会处理在root之前创建的block(只会递归向下删除cow block的索引)
			
		-walk_up_tree如果整个block的slot没遍历完不做处理，继续给walk_down_tree遍历下一个slot。如果整个slot遍历完，需要walk_up_proc释放对block的索引(update_ref是释放full_ref，drop_ref释放ref)，并且继续向上调整level
			1.walk_up_proc在update_ref时，发现不是最高层的shared_level，不会对full_ref进行处理。只会删除最高层的shared_level，并将之后的状态转换为drop_reference
			2.walk_up_proc在处理到leaf的时候，btrfs_dec_ref如果发现有extent_data，会删除对extent_data的引用
    */
    merge_reloc_roots(rc);
    ... ...
}
```

## btrfs_dev_replace_start
当磁盘发生了物理损坏，对于RAID1和RAID56而言是可以在[Btrfs读写](./btrfs_raid2.html)过程中进行数据恢复。但是此时系统将会不支持再次磁盘损坏之后的数据恢复。所以可以通过"btrfs replace start"将损坏磁盘替换，并恢复损坏磁盘上的数据
```c
int btrfs_dev_replace_start(struct btrfs_root *root,
			    struct btrfs_ioctl_dev_replace_args *args)
{
... ...
	/*找到要被替换的src_dev*/
	ret = btrfs_dev_replace_find_srcdev(root, args->start.srcdevid,
					    args->start.srcdev_name,
					    &src_device);
... ...
	/*将tgt_device加入到fs_info->fs_devices->devices链表中*/
	ret = btrfs_init_dev_replace_tgtdev(root, args->start.tgtdev_name,
					    src_device, &tgt_device);
... ...
	/*设置dev_replace*/
	dev_replace->replace_state = BTRFS_IOCTL_DEV_REPLACE_STATE_STARTED;
	dev_replace->time_started = get_seconds();
	dev_replace->cursor_left = 0;
	dev_replace->committed_cursor_left = 0;
	dev_replace->cursor_left_last_write_of_item = 0;
	dev_replace->cursor_right = 0;
	dev_replace->is_valid = 1;
	dev_replace->item_needs_writeback = 1;
	args->result = BTRFS_IOCTL_DEV_REPLACE_RESULT_NO_ERROR;
... ...
	/*
	功能分析：btrfs_scrub_dev将src_dev上所有的dev_extent的stripe找到，并通过scrub_stripe写道tgt_device上
	函数分析：
	1.btrfs_scrub_dev会有两种情况会进，一种是做data_scrub(数据清洗)，还有一种是做dev_replace
	2.如果是做data_scrub,会在scrub_pages中通过scrub_add_page_to_rd_bio将数据读取进来，完成读请求之后通过scrub_bio_end_io_worker中scrub_block_complete进行csum检查，如果出错：
		-如果是super，因为dev无法恢复，所以只能记录该dev super出错
		-如果是extent_data没有csum,会通过引用extent_data所有的(inode,offset)数据落盘，用于恢复failed_dev的数据
		-如果是meta_data或者extent_data with csum, 会将fail_dev中的数据重新读进内存并校验csum，如果还是出错，此时只能处理io_error,无法恢复csum_error和header_error
			1.会将其他mirror中的数据读进内存(如果是raid56其他mirror有错，会尝试通过parity恢复),查看备份中是否有好的数据；如果有将备份数据落盘，并且再次读取看是否有错
	3.如果是dev_replace
		-如果要替换的是dev上的parity，会通过scrub_add_page_to_rd_bio提交读取src_dev请求(用于finish_parity_scrub对比),在scrub_bio_end_io_worker的scrub_block_put中，通过scrub_parity_check_and_repair异步提交读请求并恢复parity，最后通过finish_parity_scrub写到tgt_dev上
		-如果是extent_data没有csum,会通过copy_nocow_pages找到所有引用extent_data的(inode,offset),然后通过将inode的最新数据写到tgt_dev
		-如果是dev_missing
			1.如果是raid1 raid10，在scrub_stripe的scrub_remap_extent中会通过find_live_mirror找到一个好的备份，然后通过normal_data的方式写到tgt_dev中
			2.如果是raid56，因为scrub_remap_extent是READ,唯一的stripe就是src_dev，所以不会更新src_dev。所以scrub_missing_raid56_pages会通过async_missing_raid56异步提交missing_raid56_work，通过rbio进行读取并恢复raid56数据。完成之后会通过scrub_missing_raid56_end_io调度scrub_missing_raid56_worker将数据写到tgt_dev上
			3.如果是raid0，因为没有备份，所以dev.missing并不会写tgt_dev
		-如果是normal_data,会通过scrub_add_page_to_rd_bio提交读请求，然后在scrub_block_complete中检查csum，并通过scrub_write_block_to_dev_replace将数据写到tgt_dev。
	4.如果在dev_replace时，scrub_add_page_to_rd_bio读的过程中发现了io_error,csum_error,header_error(和2一样，在scrub_block_complete中处理)，会通过2中的方式恢复数据，如果可以恢复会直接写到tgt_dev,否则会向tgt_dev上写zero_page.
	*/
	ret = btrfs_scrub_dev(fs_info, src_device->devid, 0,
			      btrfs_device_get_total_bytes(src_device),
			      &dev_replace->scrub_progress, 0, 1);
				  
	/*释放dev_replace,并通过btrfs_dev_replace_update_device_in_mapping_tree将chunk.em映射到src_dev的map替换成tgt_dev*/
	ret = btrfs_dev_replace_finishing(root->fs_info, ret);
}
```