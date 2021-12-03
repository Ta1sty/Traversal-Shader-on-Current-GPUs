#include "Raytrace.h"

#include <stdlib.h>
#include <string.h>

#include "VulkanUtil.h"
#include "Util.h"
#include <vulkan/vulkan_core.h>
// see https://github.com/MomentsInGraphics/vulkan_renderer, this macro creates a function pointer for dynamic function handles of vulkan
#define VK_LOAD(FUNCTION_NAME) PFN_##FUNCTION_NAME p##FUNCTION_NAME = (PFN_##FUNCTION_NAME) glfwGetInstanceProcAddress(info->instance, #FUNCTION_NAME);

void build_acceleration_structures(VkInfo* info, Scene* scene, VkBool32 useMultiLevel)
{
	if (useMultiLevel == VK_TRUE)
		return;
	TLAS tlas = build_acceleration_structure_for_node(info, scene,
		&scene->scene_nodes[scene->scene_data.numSceneNodes - 1]);
	scene->tlas = tlas;
}

void prepare_scene(Scene* scene, VkBool32 useMultiLevel)
{
	if (useMultiLevel == VK_TRUE)
		return;
	collapse_parent_nodes(scene);
}

void create_ray_descriptors(VkInfo* info, Scene* scene, uint32_t binding)
{
	VkDescriptorSetLayoutBinding layout_binding = {
		.binding = binding,
		.descriptorType = VK_DESCRIPTOR_TYPE_ACCELERATION_STRUCTURE_KHR,
		.descriptorCount = 1,
		.stageFlags = VK_SHADER_STAGE_FRAGMENT_BIT
	};
	VkDescriptorSetLayoutCreateInfo layout_create_info = { 0 };
	layout_create_info.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO;
	layout_create_info.bindingCount = 1;
	layout_create_info.pBindings = &layout_binding;

	check(vkCreateDescriptorSetLayout(info->device, &layout_create_info, NULL, &info->ray_descriptor.set_layout), "");
	info->ray_descriptor.binding = binding;
}

void init_ray_descriptors(VkInfo* info, Scene* scene)
{
	VkDescriptorSetAllocateInfo allocInfo = { 0 };
	allocInfo.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO;
	allocInfo.descriptorPool = info->descriptor_pool;
	allocInfo.descriptorSetCount = 1;
	allocInfo.pSetLayouts = &info->ray_descriptor.set_layout;

	check(vkAllocateDescriptorSets(info->device, &allocInfo, &info->ray_descriptor.descriptor_set), "");

	VkWriteDescriptorSetAccelerationStructureKHR descriptorAS = {
		.accelerationStructureCount = 1,
		.sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET_ACCELERATION_STRUCTURE_KHR,
		.pAccelerationStructures = &scene->tlas.structure,
		.pNext = NULL
	};
	VkWriteDescriptorSet write = {
		.pNext = &descriptorAS,
		.dstBinding = info->ray_descriptor.binding,
		.descriptorCount = 1,
		.sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET,
		.dstSet = info->ray_descriptor.descriptor_set,
		.descriptorType = VK_DESCRIPTOR_TYPE_ACCELERATION_STRUCTURE_KHR
	};
	vkUpdateDescriptorSets(info->device, 1, &write, 0, NULL);
}

// for the basic creation of acceleration structures you may also
// see https://github.com/MomentsInGraphics/vulkan_renderer
TLAS build_acceleration_structure_for_node(VkInfo* info, Scene* scene, SceneNode* node)
{
	// credits to christopher
	VK_LOAD(vkGetAccelerationStructureBuildSizesKHR)
		VK_LOAD(vkCreateAccelerationStructureKHR)
		VK_LOAD(vkGetAccelerationStructureDeviceAddressKHR)
		VK_LOAD(vkCmdBuildAccelerationStructuresKHR)

	// 2 things to do
	// if node references geometry calls build BLAS for just the geometry
	// if node references children call buildBLAS for every child node
	
	uint32_t instance_count = node->NumChildren;

	VkBuffer stagingBuffer;
	VkDeviceMemory stagingMemory;
	VkAccelerationStructureInstanceKHR* staging_data;
	createBuffer(info, sizeof(VkAccelerationStructureInstanceKHR) * instance_count,
		VK_BUFFER_USAGE_ACCELERATION_STRUCTURE_BUILD_INPUT_READ_ONLY_BIT_KHR |
		VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT,
		VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT, &stagingBuffer, &stagingMemory);

	check(vkMapMemory(info->device, stagingMemory, 0, sizeof(VkAccelerationStructureInstanceKHR) * instance_count, 0, &staging_data), "");

	BLAS* blases = malloc(sizeof(BLAS) * instance_count);
	VkAccelerationStructureInstanceKHR* instances = malloc(sizeof(VkAccelerationStructureInstanceKHR) * instance_count);

	for (int i = 0; i < instance_count; i++) {
		SceneNode* child = &scene->scene_nodes[scene->node_indices[node->childrenIndex + i]];
		blases[i] = build_blas(info, scene, child);
		// Specify the only instance
		VkAccelerationStructureDeviceAddressInfoKHR address_request = {
				.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_DEVICE_ADDRESS_INFO_KHR,
				.accelerationStructure = blases[i].structure,
		};
		VkAccelerationStructureInstanceKHR instance = {
			.transform = {
				.matrix = {
					{1.0f, 0.0f, 0.0f, 0.0f},
					{0.0f, 1.0f, 0.0f, 0.0f},
					{0.0f, 0.0f, 1.0f, 0.0f},
				}
			},
			.mask = 0xFF,
			.flags = VK_GEOMETRY_INSTANCE_FORCE_OPAQUE_BIT_KHR | VK_GEOMETRY_INSTANCE_TRIANGLE_FACING_CULL_DISABLE_BIT_KHR,
			.accelerationStructureReference = pvkGetAccelerationStructureDeviceAddressKHR(info->device, &address_request),
		};

		memcpy(&instance.transform.matrix, &blases[i].node.transform, sizeof(float) * 4 * 3);
		memcpy(&staging_data[i], &instance, sizeof(VkAccelerationStructureInstanceKHR));
	}


	// Figure out how big the buffers for the bottom-level need to be

	// Figure out how big the buffers for the top-level need to be
	VkAccelerationStructureBuildSizesInfoKHR top_sizes = {
		.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_BUILD_SIZES_INFO_KHR,
	};
	VkBufferDeviceAddressInfo instances_address = {
		.sType = VK_STRUCTURE_TYPE_BUFFER_DEVICE_ADDRESS_INFO,
		.buffer = stagingBuffer
	};
	VkAccelerationStructureGeometryKHR top_geometry = {
		.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_GEOMETRY_KHR,
		.geometryType = VK_GEOMETRY_TYPE_INSTANCES_KHR,
		.geometry = {
			.instances = {
				.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_GEOMETRY_INSTANCES_DATA_KHR,
				.arrayOfPointers = VK_FALSE,
				.data = {.deviceAddress = vkGetBufferDeviceAddress(info->device, &instances_address)},
			},
		},
		.flags = VK_GEOMETRY_OPAQUE_BIT_KHR,
	};
	VkAccelerationStructureBuildGeometryInfoKHR top_build_info = {
		.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_BUILD_GEOMETRY_INFO_KHR,
		.type = VK_ACCELERATION_STRUCTURE_TYPE_TOP_LEVEL_KHR,
		.flags = VK_BUILD_ACCELERATION_STRUCTURE_PREFER_FAST_TRACE_BIT_KHR,
		.mode = VK_BUILD_ACCELERATION_STRUCTURE_MODE_BUILD_KHR,
		.geometryCount = 1, .pGeometries = &top_geometry,
	};
	pvkGetAccelerationStructureBuildSizesKHR(
		info->device, VK_ACCELERATION_STRUCTURE_BUILD_TYPE_DEVICE_KHR,
		&top_build_info, &instance_count, &top_sizes);

	// Create buffers for the acceleration structures

	VkBuffer tlasBuffer;
	VkDeviceMemory tlasMemory;

	createBuffer(info, top_sizes.accelerationStructureSize,
		VK_BUFFER_USAGE_SHADER_BINDING_TABLE_BIT_KHR | VK_BUFFER_USAGE_ACCELERATION_STRUCTURE_STORAGE_BIT_KHR,
		VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, &tlasBuffer, &tlasMemory);

	VkAccelerationStructureKHR structure;

	VkAccelerationStructureCreateInfoKHR create_info = {
		.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_CREATE_INFO_KHR,
		.buffer = tlasBuffer,
		.offset = 0, .size = top_sizes.accelerationStructureSize,
		.type = VK_ACCELERATION_STRUCTURE_TYPE_TOP_LEVEL_KHR,
	};
	check(pvkCreateAccelerationStructureKHR(info->device, &create_info, NULL, &structure), "");

	VkBuffer scratchBuffer;
	VkDeviceMemory scratchMemory;

	createBuffer(info, top_sizes.buildScratchSize,
		VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT,
		VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, &scratchBuffer, &scratchMemory);

	// Get ready to record commands
	VkCommandBuffer cmd = beginSingleTimeCommands(info);
	// Build bottom- and top-level acceleration structures in this order
	VkAccelerationStructureBuildRangeInfoKHR build_ranges[] = {
		{.primitiveCount = instance_count}
	};
	const char* level_name = "top";
	VkAccelerationStructureBuildGeometryInfoKHR build_info = top_build_info;
	VkBufferDeviceAddressInfo scratch_adress_info = {
		.sType = VK_STRUCTURE_TYPE_BUFFER_DEVICE_ADDRESS_INFO,
		.buffer = scratchBuffer
	};
	build_info.scratchData.deviceAddress = vkGetBufferDeviceAddress(info->device, &scratch_adress_info);
	build_info.dstAccelerationStructure = structure;
	const VkAccelerationStructureBuildRangeInfoKHR* build_range = &build_ranges[0];
	pvkCmdBuildAccelerationStructuresKHR(cmd, 1, &build_info, &build_range);
	// Enforce synchronization
	VkMemoryBarrier after_build_barrier = {
		.sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER,
		.srcAccessMask = VK_ACCESS_ACCELERATION_STRUCTURE_WRITE_BIT_KHR | VK_ACCESS_ACCELERATION_STRUCTURE_READ_BIT_KHR,
		.dstAccessMask = VK_ACCESS_ACCELERATION_STRUCTURE_WRITE_BIT_KHR | VK_ACCESS_ACCELERATION_STRUCTURE_READ_BIT_KHR,
	};
	vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_ACCELERATION_STRUCTURE_BUILD_BIT_KHR,
		VK_PIPELINE_STAGE_ACCELERATION_STRUCTURE_BUILD_BIT_KHR, 0,
		1, &after_build_barrier, 0, NULL, 0, NULL);
	// Submit the command buffer

	endSingleTimeCommands(info, cmd);

	TLAS tlas = {
		.buffer = tlasBuffer,
		.memory = tlasMemory,
		.node = *node,
		.structure = structure
	};
	return tlas;
}

// for the basic creation of acceleration structures you may also
// see https://github.com/MomentsInGraphics/vulkan_renderer
BLAS build_blas(VkInfo* info, Scene* scene, SceneNode* node)
{
	// 2 things to do
	// if node references geometry add relevant geometry
	// if node references children recursively create new TLAS
	// and add traversalNodes

	// credits to christopher
	VK_LOAD(vkGetAccelerationStructureBuildSizesKHR)
		VK_LOAD(vkCreateAccelerationStructureKHR)
		VK_LOAD(vkGetAccelerationStructureDeviceAddressKHR)
		VK_LOAD(vkCmdBuildAccelerationStructuresKHR)

		VkBuffer indexStage;
	VkDeviceMemory indexStageMemeory;
	void* index_data;
	createBuffer(info, sizeof(uint32_t) * node->NumTriangles * 3,
		VK_BUFFER_USAGE_ACCELERATION_STRUCTURE_BUILD_INPUT_READ_ONLY_BIT_KHR |
		VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT,
		VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT, &indexStage, &indexStageMemeory);
	check(vkMapMemory(info->device, indexStageMemeory, 0, sizeof(uint32_t) * node->NumTriangles * 3, 0,
		&index_data), "error Mapping memeory");

	uint32_t maxIndex = 0; // the maximum index used in the indexBuffer for this mesh
	uint32_t minIndex = UINT32_MAX; // the minimum index used in the indexBuffer for this mesh.
	uint32_t* indices = index_data;
	for (uint32_t i = 0; i != node->NumTriangles * 3; ++i)
	{
		minIndex = min(minIndex, scene->indices[i + node->IndexBufferIndex]);
		maxIndex = max(maxIndex, scene->indices[i + node->IndexBufferIndex]);
	}

	for (uint32_t i = 0; i != node->NumTriangles; ++i)
	{
		indices[i * 3 + 0] = scene->indices[i * 3 + 0 + node->IndexBufferIndex] - minIndex; // there should always be one where this is 0
		indices[i * 3 + 1] = scene->indices[i * 3 + 1 + node->IndexBufferIndex] - minIndex; // there should always be one where this is 0
		indices[i * 3 + 2] = scene->indices[i * 3 + 2 + node->IndexBufferIndex] - minIndex; // there should always be one where this is 0
	}
	// create vertex stage buffer
	uint32_t numVertices = maxIndex - minIndex + 1;
	VkBuffer vertexStage;
	VkDeviceMemory vertexStageMemeory;
	void* vertex_data;
	createBuffer(info, numVertices * sizeof(float) * 3,
		VK_BUFFER_USAGE_ACCELERATION_STRUCTURE_BUILD_INPUT_READ_ONLY_BIT_KHR |
		VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT,
		VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT, &vertexStage, &vertexStageMemeory);
	check(vkMapMemory(info->device, vertexStageMemeory, 0, numVertices * sizeof(float) * 3, 0,
		&vertex_data), "error Mapping memeory");

	float* vertices = vertex_data;
	for (uint32_t i = 0; i != numVertices; ++i)
	{
		vertices[i * 3 + 0] = scene->vertices[i + minIndex].position[0];
		vertices[i * 3 + 1] = scene->vertices[i + minIndex].position[1];
		vertices[i * 3 + 2] = scene->vertices[i + minIndex].position[2];
	}

	// naive vertex array

	/*VkBuffer vertexStage;
	VkDeviceMemory vertexStageMemeory;
	void* vertex_data;
	createBuffer(info, node->NumTriangles * sizeof(float) * 3,
		VK_BUFFER_USAGE_ACCELERATION_STRUCTURE_BUILD_INPUT_READ_ONLY_BIT_KHR |
		VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT,
		VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT, &vertexStage, &vertexStageMemeory);
	check(vkMapMemory(info->device, vertexStageMemeory, 0, node->NumTriangles * sizeof(float) * 3, 0,
		&vertex_data), "error Mapping memeory");

	float* vertices = vertex_data;
	for (uint32_t i = 0; i != node->NumTriangles * 3 * 3; i += 3)
	{
		Vertex v = scene->vertices[scene->indices[i / 3 + node->IndexBufferIndex]];
		vertices[i + 0] = v.position[0];
		vertices[i + 1] = v.position[1];
		vertices[i + 2] = v.position[2];
	}*/




	// Figure out how big the buffers for the bottom-level need to be
	uint32_t primitive_count = node->NumTriangles;
	VkAccelerationStructureBuildSizesInfoKHR bottom_size = {
		.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_BUILD_SIZES_INFO_KHR,
	};
	VkBufferDeviceAddressInfo vertices_address = {
		.sType = VK_STRUCTURE_TYPE_BUFFER_DEVICE_ADDRESS_INFO,
		.buffer = vertexStage
	};

	VkBufferDeviceAddressInfo index_address = {
		.sType = VK_STRUCTURE_TYPE_BUFFER_DEVICE_ADDRESS_INFO,
		.buffer = indexStage
	};
	VkAccelerationStructureGeometryKHR bottom_geometry = {
		.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_GEOMETRY_KHR,
		.geometryType = VK_GEOMETRY_TYPE_TRIANGLES_KHR,
		.geometry = {
			.triangles = {
				.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_GEOMETRY_TRIANGLES_DATA_KHR,
				.vertexData = {.deviceAddress = vkGetBufferDeviceAddress(info->device, &vertices_address)},
				.maxVertex = primitive_count * 3 - 1,
				.vertexStride = 3 * sizeof(float),
				.indexType = VK_INDEX_TYPE_UINT32,
				.vertexFormat = VK_FORMAT_R32G32B32_SFLOAT,
				.indexData = {.deviceAddress = vkGetBufferDeviceAddress(info->device, &index_address)}
			},
		},
		.flags = VK_GEOMETRY_OPAQUE_BIT_KHR,
	};
	VkAccelerationStructureBuildGeometryInfoKHR bottom_build_info = {
		.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_BUILD_GEOMETRY_INFO_KHR,
		.type = VK_ACCELERATION_STRUCTURE_TYPE_BOTTOM_LEVEL_KHR,
		.flags = VK_BUILD_ACCELERATION_STRUCTURE_PREFER_FAST_TRACE_BIT_KHR,
		.mode = VK_BUILD_ACCELERATION_STRUCTURE_MODE_BUILD_KHR,
		.geometryCount = 1, .pGeometries = &bottom_geometry,
	};
	pvkGetAccelerationStructureBuildSizesKHR(
		info->device, VK_ACCELERATION_STRUCTURE_BUILD_TYPE_DEVICE_KHR,
		&bottom_build_info, &primitive_count, &bottom_size);

	// Create buffers for the acceleration structures

	VkBuffer blasBuffer = 0;
	VkDeviceMemory blasMemory = 0;
	createBuffer(info, bottom_size.accelerationStructureSize,
		VK_BUFFER_USAGE_SHADER_BINDING_TABLE_BIT_KHR | VK_BUFFER_USAGE_ACCELERATION_STRUCTURE_STORAGE_BIT_KHR,
		VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, &blasBuffer, &blasMemory);

	// Create the acceleration structures
	VkAccelerationStructureCreateInfoKHR create_info = {
		.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_CREATE_INFO_KHR,
		.buffer = blasBuffer,
		.offset = 0, .size = bottom_size.accelerationStructureSize,
		.type = VK_ACCELERATION_STRUCTURE_TYPE_BOTTOM_LEVEL_KHR,
	};

	VkAccelerationStructureKHR structure;

	check(pvkCreateAccelerationStructureKHR(info->device, &create_info, NULL, &structure), "");


	// Allocate scratch memory for the build
	VkBuffer scratchBuffer = 0;
	VkDeviceMemory scratchBufferMemeory = 0;

	createBuffer(info, bottom_size.buildScratchSize,
		VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT,
		VK_MEMORY_HEAP_DEVICE_LOCAL_BIT, &scratchBuffer, &scratchBufferMemeory);

	// Specify the only instance
	VkCommandBuffer cmd = beginSingleTimeCommands(info);
	// Build bottom- and top-level acceleration structures in this order
	VkAccelerationStructureBuildRangeInfoKHR build_ranges[] = {
		{.primitiveCount = (uint32_t)node->NumTriangles}
	};
	const char* level_name = "bottom";
	VkBufferDeviceAddressInfo scratch_adress_info = {
		.sType = VK_STRUCTURE_TYPE_BUFFER_DEVICE_ADDRESS_INFO,
		.buffer = scratchBuffer
	};
	bottom_build_info.scratchData.deviceAddress = vkGetBufferDeviceAddress(info->device, &scratch_adress_info);
	bottom_build_info.dstAccelerationStructure = structure;
	const VkAccelerationStructureBuildRangeInfoKHR* build_range = &build_ranges[0];
	pvkCmdBuildAccelerationStructuresKHR(cmd, 1, &bottom_build_info, &build_range);
	// Enforce synchronization
	VkMemoryBarrier after_build_barrier = {
		.sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER,
		.srcAccessMask = VK_ACCESS_ACCELERATION_STRUCTURE_WRITE_BIT_KHR | VK_ACCESS_ACCELERATION_STRUCTURE_READ_BIT_KHR,
		.dstAccessMask = VK_ACCESS_ACCELERATION_STRUCTURE_WRITE_BIT_KHR | VK_ACCESS_ACCELERATION_STRUCTURE_READ_BIT_KHR,
	};
	vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_ACCELERATION_STRUCTURE_BUILD_BIT_KHR,
		VK_PIPELINE_STAGE_ACCELERATION_STRUCTURE_BUILD_BIT_KHR, 0,
		1, &after_build_barrier, 0, NULL, 0, NULL);

	endSingleTimeCommands(info, cmd);

	vkDestroyBuffer(info->device, vertexStage, NULL);
	vkDestroyBuffer(info->device, indexStage, NULL);
	vkDestroyBuffer(info->device, scratchBuffer, NULL);
	vkFreeMemory(info->device, vertexStageMemeory, NULL);
	vkFreeMemory(info->device, indexStageMemeory, NULL);
	vkFreeMemory(info->device, scratchBufferMemeory, NULL);

	BLAS b = {
		.node = *node,
		.structure = structure,
		.buffer = blasBuffer,
		.memory = blasMemory
	};
	return b;
}
