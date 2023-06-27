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
		1.tree_block_ref_key是普通root下对tree_block的引用，其iref.offset指向的是root
		2.shared_block_ref_key是在relocate_root下对tree_block的引用，其iref.offset指向upper.eb.start，是full_ref.
	4.申请的chunk空间可以如果用于extent_data，有以下两种类型
		1.extent_data_ref_key是普通root下对extent_data的引用,ref.root ref.objectid  ref.offset  ref.count分别表示其所在的root，其所在的inode，其在inode中的逻辑偏移，其被inode引用的次数。
		2.shared_data_ref_key是relocate_root对extent_data的引用，其iref.offset指向其upper.eb.start，是full_ref
	*/
	ret = find_next_extent(rc, path, &key);
	... ...
	if (flags & BTRFS_EXTENT_FLAG_TREE_BLOCK) {
		/*
		功能分析:如果extent_item是tree_block，通过add_tree_block将tree_block的信息加入到红黑树blocks中
		注：这个extent_item在MOVE_DATA_EXTENTS被relocate，所以其extent_item会被删除(在relocate_tree_block时，通过btrfs_cow_block或者btrfs_drop_subtree被删除)。所以在UPDATE_DATA_PTRS时已经搜索不到在block_group中的tree_block
		*/
		ret = add_tree_block(rc, &key, path, &blocks);
	} else if (rc->stage == UPDATE_DATA_PTRS &&
		   (flags & BTRFS_EXTENT_FLAG_DATA)) {
		 /*
		 功能分析：在relocate的第二阶段，需要找到引用extent_data的tree_block，因为在第一阶段已经将extent_data relocate，所以需要更新这些tree_block的reference
		 函数分析：
		 1.对于share_data_ref，因为其iref.offset直接指向的是其upper.eb.start，所以直接通过__add_tree_block将upper加到红黑树blocks中
		 2.对于extent_data_ref，find_data_references会在root中找其inode相应的offset对应的extent_data_key所在的tree_block
			- 
		 */
		ret = add_data_references(rc, &key, path, &blocks);
	} else {
		btrfs_release_path(path);
		ret = 0;
	}
	
	}
}
```

## btrfs_dev_replace_start
当磁盘发生了物理损坏，对于RAID1和RAID56而言是可以在[Btrfs读写](./btrfs_raid2.html)过程中进行数据恢复。但是此时系统将会不支持再次磁盘损坏之后的数据恢复。所以可以通过"btrfs replace start"将损坏磁盘替换，并恢复损坏磁盘上的parity数据(恢复整个磁盘的数据可能会花比较长的时间，所以只恢复parity，其他数据在用的时候再落盘)