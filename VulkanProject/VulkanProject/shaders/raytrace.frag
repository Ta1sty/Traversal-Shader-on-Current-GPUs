
#ifndef STRUCTS
#include "structs.frag"
#endif

#ifdef RAY_QUERIES
#include "QueryTraceRecord.frag"
layout(binding = TLAS_BINDING, set = 3) uniform accelerationStructureEXT[] tlas;
#endif

#ifndef MATH
#include "math.frag"
#endif

void getHitPayload(int triangle, vec3 tuv, out vec3 N, out Material material) {
	Vertex v0 = vertices[indices[triangle * 3]];
	Vertex v1 = vertices[indices[triangle * 3 + 1]];
	Vertex v2 = vertices[indices[triangle * 3 + 2]];
	float w = 1 - tuv.y - tuv.z;
	float u = tuv.y;
	float v = tuv.z;


	// compute interpolated Normal and Tex - important this is in object space -> need to transform either 
	N = w * v0.normal + v * v1.normal + u * v2.normal;
	N = normalize(N);
	vec2 tex = w * v0.tex_coord + v * v1.tex_coord + u * v2.tex_coord;

	// get material and texture properties, if there are not set use default values
	if (v0.material_index < 0 || !renderTextures) {
		material.k_a = 0.2f;
		material.k_d = 0.5f;
		material.k_s = 0.3f;
		material.k_t = 0;
		material.k_r = 0;
		material.n = 1;
		material.texture_index = -1;
		if (!renderTextures)
			material.color = vec4(0.8, 0.8, 0.8, 1);
		else
			material.color = vec4(0.2, 0.4, 0.8, 1);
	}
	else {
		material = materials[v0.material_index];
		if (material.texture_index >= 0)
			material.color = texture(sampler2D(textures[material.texture_index], samp), tex);
	}

	// debug
	if (!debug) return;

	SetDebugCol(displayUV, vec4(u, v, 0, 1));
	SetDebugCol(displayTex, vec4(tex.x, tex.y, 0, 1));
	SetDebugHsv(displayTriangleIdx, triangle, colorSensitivity, false);
	if (v0.material_index >= 0)
		SetDebugHsv(displayMaterialIdx, v0.material_index, colorSensitivity, true);
	else
		SetDebugCol(displayMaterialIdx, vec4(0.2, 0.4, 0.8, 1));

	if (material.texture_index >= 0)
		SetDebugHsv(displayTextureIdx, material.texture_index, colorSensitivity, true);
	else
		SetDebugCol(displayTextureIdx, vec4(0.2, 0.4, 0.8, 1));
}
SceneNode selectLOD(SceneNode selector, float tNear, mat3 tr, int parentLOD, out int lod){
	SceneNode dummy = nodes[childIndices[selector.ChildrenIndex]];
	int N = dummy.NumChildren;
	if(parentLOD >= 0) {
		lod = parentLOD;
	} else {
		float rObject = length(selector.AABB_max-selector.AABB_min)/2;

		float rMax = 5000;
		float t = max(0,tNear);
		float rPixel = rObject * height / (tan(PI / 180 * fov) * 2 * t);
		lod = -int(log2(pow(2,N-1) * rPixel/rMax));
		lod = max(lod, 0);
	}
	lod = min(lod, N-1);
	return nodes[childIndices[dummy.ChildrenIndex + lod]];
}


// ONLY modify these when in the instanceShader or the rayTrace Loop
struct TraversalPayload {
	mat4x3 world_to_object;
	float tNear; // the t for which this aabb was intersected
	int cIdx_nIdx; // after compute: node index; before compute: custom index
	int pIdx_lod; // after compute: LOD       ; before compute: primitve index
	int sIdx_un; // after compute: unsused   ; bebore compute: shaderOffset (grandchild)
};

#ifdef RAY_QUERIES
// use a stack because:
// keep the list as short as possible, I.E. use a depth first search
const int TRAVERSAL_STACK_SIZE = 30;
int stackSize = 0;	
TraversalPayload traversalStack[TRAVERSAL_STACK_SIZE];

int traversalDepth = 0;
uint numTraversals = 0;
uint queryCount = 0;
void instanceShader(SceneNode tlas, int index, vec3 rayOrigin, vec3 rayDirection, int parentLOD){	
	TraversalPayload nextLoad = traversalStack[index];
	mat4x3 world_to_object;

	// compute the blas
	SceneNode blas;
	if(tlas.IsInstanceList)	{
		SceneNode instance = nodes[nextLoad.cIdx_nIdx];
		blas = nodes[nextLoad.sIdx_un];
		world_to_object = mat4x3(mat4(inv(transforms[blas.TransformIndex])) * mat4(inv(transforms[instance.TransformIndex])));
	} else {
		blas = nodes[nextLoad.cIdx_nIdx];
		world_to_object = inv(transforms[blas.TransformIndex]);
	}

	// compute the next node
	SceneNode next;
	if(blas.IsInstanceList){
		SceneNode dummy = nodes[childIndices[blas.ChildrenIndex]];
		SceneNode instance = nodes[childIndices[dummy.ChildrenIndex+nextLoad.pIdx_lod]];
		next = nodes[childIndices[instance.ChildrenIndex]];
		world_to_object = mat4x3(mat4(inv(transforms[instance.TransformIndex])) * mat4(world_to_object));
	} else {
		next = nodes[childIndices[blas.ChildrenIndex + nextLoad.pIdx_lod]];
	}

	// discard is not possible without either reodering the buffer or some other operation
	// therefore to discard an instance hit, set tMax to high value
	// to add more then one traversal load, just set the loads and the stacksize accordingly
	// reordering the buffer can be troublesome so just add them at the end, they will get exectued first
	// the ordering of the instancehits is still kept. Meaning the instance and all added loads will get exectued before the loads
	// that were of the previous one

	// we can now do LOD or whatever we feel like doing
	
	vec3 origin = world_to_object * vec4(nextLoad.world_to_object * vec4(rayOrigin,1),1);
	vec3 direction = world_to_object * vec4(nextLoad.world_to_object * vec4(rayDirection,0),0);

	// need to compute tNear to sort out instanceHits of AABBs that are behind a previous triangle hit
	float tNear, tFar;
	intersectAABB(origin, direction, next.AABB_min, next.AABB_max, tNear, tFar);
	int lod = parentLOD;
	if(next.IsLodSelector) {
		mat3 tr = mat3(world_to_object * mat4(nextLoad.world_to_object));
		next = selectLOD(next,tNear, tr, parentLOD, lod);
	}

	world_to_object = mat4x3(mat4(inv(transforms[next.TransformIndex])) * mat4(world_to_object));
	
	// here the shader adds the next payloads
	nextLoad.cIdx_nIdx = next.Index;
	nextLoad.world_to_object = mat4x3(mat4(world_to_object) * mat4(nextLoad.world_to_object));
	nextLoad.tNear = tNear;
	nextLoad.pIdx_lod = lod;
	traversalStack[index] = nextLoad;
	
	if (debug && displayAABBs) {
		debugAABB(origin, direction, next);
	}
}


void triangleHit(rayQueryEXT ray_query, SceneNode node, float minAlpha) {
	float t = rayQueryGetIntersectionTEXT(ray_query, false);
	vec2 uv = rayQueryGetIntersectionBarycentricsEXT(ray_query, false);
	uint cIdx = rayQueryGetIntersectionInstanceCustomIndexEXT(ray_query, false);
	SceneNode blasChild = nodes[cIdx];
	int triangle = blasChild.IndexBufferIndex / 3 + rayQueryGetIntersectionPrimitiveIndexEXT(ray_query, false);
	Vertex v0 = vertices[indices[triangle * 3]];
	Vertex v1 = vertices[indices[triangle * 3 + 1]];
	Vertex v2 = vertices[indices[triangle * 3 + 2]];

	vec3 tuv;
	tuv.x = t;
	tuv.y = uv.y;
	tuv.z = uv.x;

	vec3 N;
	Material material;
	getHitPayload(triangle, tuv, N, material);
	if (material.color[3] > minAlpha)
		rayQueryConfirmIntersectionEXT(ray_query);
}

bool ray_trace_loop(vec3 rayOrigin, vec3 rayDirection, float t_max, uint root, float minAlpha, int lod,out vec3 tuv, out int triangle_index, out TraversalPayload resultPayload) {
	numTraversals = 0;

	tuv = vec3(0);

	float min_t = 1.0e-4f;
	float best_t = t_max;

	TraversalPayload start; // start at root node
	start.world_to_object = mat4x3(1);
	start.cIdx_nIdx = int(root);
	start.pIdx_lod = lod;
	start.tNear = 0;

	if (debug && displayAABBs) {
		SceneNode root = nodes[root];
		debugAABB(rayOrigin, rayDirection, root);
	}

	traversalStack[0] = start;

	triangle_index = -1;
	stackSize = 1;

	uint triangleTLAS = -1;
	while (stackSize > 0) {
		stackSize--; // remove last element
		TraversalPayload load = traversalStack[stackSize];
		if (load.tNear >= best_t) continue;// there was already a closer hit, we can skip this one

		int start = stackSize;
		SceneNode node = nodes[load.cIdx_nIdx]; // retrieve scene Node
		traversalDepth = max(node.Level, traversalDepth); // not 100% correct but it gives a vague idea

		uint tlasNumber = node.TlasNumber;
		vec3 query_origin = (load.world_to_object * vec4(rayOrigin,1)).xyz;
		vec3 query_direction = (load.world_to_object * vec4(rayDirection,0)).xyz;

		if (debug && displayAABBs) {
			for (int i = 0; i < node.NumChildren; i++) {
				SceneNode directChild = nodes[childIndices[node.ChildrenIndex + i]];
				debugAABB(query_origin, query_direction, directChild);
			}
			if(node.IsInstanceList){
				if(displayListAABBs){
					SceneNode list = nodes[childIndices[node.ChildrenIndex]];
					for (int i = 0; i < min(50,list.NumChildren); i++) {
						SceneNode child = nodes[childIndices[list.ChildrenIndex + i]];
						debugAABB(query_origin, query_direction, child);
					}
				}
			}
		}

		rayQueryEXT ray_query;
		rayQueryInitializeEXT(ray_query, tlas[tlasNumber], 0, 0xFF,
			query_origin, min_t,
			query_direction, best_t);

		queryCount++;
		numTraversals++;
		uint triangleIntersections = 0;
		uint instanceIntersections = 0;
		while (rayQueryProceedEXT(ray_query)) {
			uint type = rayQueryGetIntersectionTypeEXT(ray_query, false);
			switch (type) {
			case gl_RayQueryCandidateIntersectionTriangleEXT:
				rayQueryConfirmIntersectionEXT(ray_query);
				break;
				// might want to check for opaque
				triangleHit(ray_query, node, minAlpha);
				//rayQueryConfirmIntersectionEXT(ray_query);
				triangleIntersections++;
				break;
			case gl_RayQueryCandidateIntersectionAABBEXT:
				// we do not want to generate intersections, since AABB hit does not guarantee a hit in the traversal
				// instead call instanceShader and add the new parameters to the traversalList
				// we need to pay attention! the query goes from smallest to largest t value and adds these to the list
				// for continuing traversal it is therfore beneficial to resume with the closest node, which was the one
				// that replaces the node that executed the query, however we still want to do a DFS. Solution for this is:
				// We reverse the list. Then the closest hit is at the end of the stack, and all added levels are still 
				// right of this node
				if(stackSize>=TRAVERSAL_STACK_SIZE)
					break;

				traversalStack[stackSize] = load;
				traversalStack[stackSize].cIdx_nIdx = rayQueryGetIntersectionInstanceCustomIndexEXT(ray_query, false);
				traversalStack[stackSize].pIdx_lod = rayQueryGetIntersectionPrimitiveIndexEXT(ray_query, false);
				traversalStack[stackSize].sIdx_un = int(rayQueryGetIntersectionInstanceShaderBindingTableRecordOffsetEXT(ray_query, false));
				stackSize++;
				instanceIntersections++;
				break;
			default: break;
			}
		}
		int end = stackSize;
		int added = end - start;
		
		for(int i = start;i < end;i++) {
			instanceShader(node, i, rayOrigin, rayDirection, load.pIdx_lod);
			//recordQuery(traversalStack[i].nIdx, node.Level, traversalStack[i].t, vec3(1,0,0), vec3(2,0,0), i-start ,added);
		}

		for (int i = 0; i < added / 2; i++) {
			int i1 = start + i;
			int i2 = end - 1 - i;
			TraversalPayload tmp1 = traversalStack[i1];
			TraversalPayload tmp2 = traversalStack[i2];
			traversalStack[i1] = tmp2;
			traversalStack[i2] = tmp1;
		}

		uint commitedType = rayQueryGetIntersectionTypeEXT(ray_query, true);
		if (commitedType == gl_RayQueryCommittedIntersectionTriangleEXT) {
			if (debug && displayTriangles) {
				vec2 uv = rayQueryGetIntersectionBarycentricsEXT(ray_query, true);
				if (uv.x + uv.y > 0.99f || uv.x < 0.01f || uv.y < 0.01f) {
					triangle_index = 0;
					return true;
				}
				else {
					continue;
				}
			}
			float t = rayQueryGetIntersectionTEXT(ray_query, true);
			if (t < best_t) {
				best_t = t;
				SceneNode blasChild;
				if(node.IsInstanceList){
					blasChild = nodes[rayQueryGetIntersectionInstanceShaderBindingTableRecordOffsetEXT(ray_query, true)];
				}
				else {
					blasChild = nodes[rayQueryGetIntersectionInstanceCustomIndexEXT(ray_query, true)];
				}
				triangle_index = blasChild.IndexBufferIndex / 3 + rayQueryGetIntersectionPrimitiveIndexEXT(ray_query, true);

				tuv.x = t;
				vec2 uv = rayQueryGetIntersectionBarycentricsEXT(ray_query, true);
				tuv.y = uv.y;
				tuv.z = uv.x;

				mat4 world_to_object = mat4(rayQueryGetIntersectionWorldToObjectEXT(ray_query, true));
				resultPayload.cIdx_nIdx = blasChild.Index;
				resultPayload.world_to_object = mat4x3(world_to_object * mat4(load.world_to_object));
				resultPayload.tNear = best_t;
				resultPayload.pIdx_lod = load.pIdx_lod;
				triangleTLAS = tlasNumber;
			}
		}
		recordQuery(node.Index, node.Level, load.tNear, rayOrigin, rayOrigin + best_t * rayDirection, triangleIntersections ,instanceIntersections);
	}
	SetDebugHsv(displayTLASNumber, triangleTLAS, colorSensitivity, true);
	return triangle_index >= 0;
}
#endif

#ifndef RAY_QUERIES
bool ray_trace_loop(vec3 rayOrigin, vec3 rayDirection, float t_max, uint root, out vec3 tuv, out int triangle_index, out TraversalPayload resultPayload) {
	vec3 tuv_next;
	tuv.x = t_max;
	triangle_index = -1;
	for (int i = 0; i < numTriangles; i++) {
		Vertex vert_v0 = vertices[indices[i * 3]];
		Vertex vert_v1 = vertices[indices[i * 3 + 1]];
		Vertex vert_v2 = vertices[indices[i * 3 + 2]];

		vec3 v0 = vert_v0.position;
		vec3 v2 = vert_v1.position;
		vec3 v1 = vert_v2.position;


		if (rayTriangleIntersect(rayOrigin, rayDirection, tuv_next, v0, v1, v2)) {
			// for showing triangles we use anyHit and early out
			if (debug != 0 && displayTriangles != 0) {
				vec2 uv = tuv_next.yz;
				if (uv.x + uv.y > 0.99f || uv.x < 0.01f || uv.y < 0.01f) {
					return true;
				}
			}
			else {
				if (tuv_next.x < tuv.x) { // compute closest hit
					vec3 N;
					vec4 color;
					Material material;
					getHitPayload(i, tuv_next, color, N, material);
					if (color[3] == 0) // test that the hit is opque, else skip it
						continue;
					triangle_index = i;
					tuv = tuv_next;
				}
			}
		}
	}

	if (triangle_index == -1) {
		return false;
	}
	return true;
}
#endif

const float MAX_T = 100000;

vec4 shadeFragment(vec3 P, vec3 V, vec3 N, Material material, int triangle, int lod) {
	// calculate lighting for each light source
	vec3 sum = vec3(0);
	for (int i = 0; i < numLights; i++) {
		Light light = lights[i];

		if ((light.type & LIGHT_ON) == 0) { // is the light on?
			continue;
		}

		vec3 L = light.position - P;
		float l_dst = length(L);
			
		float specular = 0;
		float diffuse = material.k_d;
		vec3 R = normalize(reflect(V, N));
		vec3 POff = P + 0.005f * N;
		if (renderShadows) {
			TraversalPayload load;
			vec3 tuvShadow;
			int index;
			if ((light.type & LIGHT_TYPE_POINT) != 0) { // point light, check if it is visible and then compute KS via L vector
				if (l_dst > light.maxDst) { // is the light near enough to even matter
					continue;
				}

				vec3 LN = normalize(L);
				if (ray_trace_loop(POff, LN, l_dst, rootSceneNode,0.9f,lod , tuvShadow, index, load)) { // is light source visible? shoot ray to lPos
					continue;
				}
				specular = material.k_s * pow(max(0, dot(R, LN)), material.n);
				// https://developer.valvesoftware.com/wiki/Constant-Linear-Quadratic_Falloff
				float d = l_dst;
				float l_mult = light.quadratic.x + light.quadratic.y / d + light.quadratic.z / (d * d);
				if (!renderDiffuse) diffuse = 0;
				if (!renderSpecular) specular = 0;
				sum += (specular + diffuse) * l_mult * light.intensity * material.color.xyz;
			}
			else if ((light.type & LIGHT_TYPE_SUN) != 0) { // directional light, check if it is visible 
				vec3 LN = normalize(light.direction);
				if (ray_trace_loop(POff, -LN, MAX_T, rootSceneNode,0.9f,lod , tuvShadow, index, load)) { // shoot shadow ray into the light source
					continue;
				}
				specular = material.k_s * pow(max(0, dot(R, -LN)), material.n);
				if (!renderDiffuse) diffuse = 0;
				if (!renderSpecular) specular = 0;
				sum += (specular + diffuse) * light.intensity * material.color.xyz;
			}
		}
	}
	if (!renderAmbient) material.k_a = 0;
	sum += material.k_a * material.color.xyz;
	return vec4(sum.xyz, material.color[3]);
}

vec4 rayTrace(vec3 rayOrigin, vec3 rayDirection, out float t) {
	int triangle = -1;
	TraversalPayload load;
	vec3 tuv;
	Material material;

	vec4 color = vec4(0, 0, 0, 0);
	int depth = 0;

	if (debug && displayTriangles) {
		int triangle = -1;
		TraversalPayload load;
		vec3 tuv;
		if (ray_trace_loop(rayOrigin, rayDirection, MAX_T, rootSceneNode,0,-1, tuv, triangle, load))
			return vec4(1, 1, 1, 1);
		else
			return vec4(0, 0, 0, 1);
	}

	float Contribution[6];
	vec3 Origin[6];
	vec3 Direction[6];

	int count = 0;
	int num = 1;
	Contribution[0] = 1;
	Origin[0] = rayOrigin;
	Direction[0] = rayDirection;
	while (num>0) {
		count++;
		num--;

		vec3 P = Origin[num];
		vec3 V = Direction[num];
		float frac = Contribution[num];
		bool hit = ray_trace_loop(P, V, MAX_T, rootSceneNode,0, -1, tuv, triangle, load);

		if(hit) {
			SetDebugHsv(displayLOD, load.pIdx_lod, 7, true);

			vec3 P = P + tuv.x * V;
			vec3 N_obj;
			getHitPayload(triangle, tuv, N_obj, material);
			vec3 N_world = normalize(transpose(mat3(load.world_to_object)) * N_obj);
			if (displayAABBs)
				debugSetEnabled = false;
			if (count == 1)
				t = tuv.x;

			vec4 fracColor = shadeFragment(P, V, N_world, material, triangle, load.pIdx_lod);

			if(debug && displayLOD){
				fracColor = 0.7f * fracColor + 0.3f * debugColor;
				debugColor = vec4(0,0,0,0);
			}

			DebugOffIfSet();
			color += frac * fracColor[3] * fracColor;

			float tr = material.k_t + (1-fracColor[3]);
			float rf = material.k_r;

			if(count>rayMaxDepth){
				tr = 0;
				rf = 0;
			}
			if(tr > 0 && renderTransmission && num<6){
				Contribution[num] = tr * frac;
				Origin[num] = P + V * 0.01f;
				Direction[num] = V;
				num++;
			}

			if(rf > 0 && renderReflection && num<6){
				Contribution[num] = rf * frac;
				vec3 dirRef = reflect(V,N_world);
				Origin[num] = P + dirRef * 0.01f;
				Direction[num] = dirRef;
				num++;
			}
		} else {
			if(count==1) {
				//SetDebugCol(true, vec4(0,0,0,0));
				t = MAX_T;
			}
			// maybe environment map
			for (int i = 0; i < numLights; i++) {
				Light light = lights[i];
				if ((light.type & LIGHT_TYPE_SUN) != 0) {
					vec3 LD = normalize(light.direction);
					vec3 VN = normalize(V);
					float fac = pow(max(0,dot(LD,-VN)),500) * 3;
					color += frac * fac * vec4(light.intensity,1);
				}
			}
			color += frac * texture(skybox,V);
		}
	}
	return color;
}


void generatePixelRay(out vec3 rayOrigin, out vec3 rayDirection) {
	ivec2 xy = ivec2(gl_FragCoord.xy);
	float x = xy.x;
	float y = xy.y;

	float flt_height = height;
	float flt_width = width;
	vec4 origin_view_space = vec4(0, 0, 0, 1);
	vec4 origin_world_space = view_to_world * origin_view_space;
	float z = flt_height / tan(PI / 180 * fov);
	vec4 direction_view_space = vec4(normalize(vec3((x - flt_width / 2.f), flt_height / 2.f - y, -z)), 0);
	vec4 direction_world_space = view_to_world * direction_view_space;

	rayOrigin = origin_world_space.xyz;
	rayDirection = direction_world_space.xyz;
}

